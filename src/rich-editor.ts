/*
 * The script's text editor: CodeMirror 6 (the editor Obsidian itself uses) with the formatting
 * markers hidden, so bold looks bold and there's never a ** to see or delete by accident.
 *
 * Every edit a person makes (typing, deleting, pasting) is redone on the Rich model in format.ts,
 * the plain text with a style per character, and written back as markers. That keeps the markers
 * balanced whatever happens, escapes a typed * or = so it stays a character, and lets new text take
 * the style of the text it's typed into, as in a word processor.
 */

import { Annotation, ChangeDesc, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { history, historyKeymap, isolateHistory, redo, standardKeymap } from "@codemirror/commands";
import { caretAfter, charStart, commonStyle, diffText, parseInline, PLAIN, rawToPlain, Rich, serialize, Style, toRich } from "./format";
import { HighlightColor } from "./types";

/** Words with a comment on them, as offsets into the raw text. */
export interface CommentSpan {
	start: number;
	end: number;
	active?: boolean;
}

export interface RichEditorOptions {
	/** Where to put the editor; leave out to place its `dom` yourself. */
	parent?: HTMLElement;
	/** Classes for the editor's outer element. */
	cls: string;
	text: string;
	placeholder: string;
	readOnly: boolean;
	/** Copy/paste type carrying formatted text between the plugin's editors. */
	clipboardType: string;
	/** Drag types the editor should leave alone (the plugin's own block dragging). */
	ignoreDragTypes: string[];
	comments: () => CommentSpan[];
	/** The text changed; `changes` maps old positions to new ones. */
	onChange: (text: string, changes: ChangeDesc) => void;
	/** The selection moved or the field gained/lost focus. */
	onSelection: () => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Runs before the editor's own keys; return true when handled. */
	onKeydown: (e: KeyboardEvent) => boolean;
}

interface Decorations {
	all: DecorationSet;
	/** Just the hidden markers, which the cursor steps over. */
	markers: DecorationSet;
	comments: CommentSpan[];
}

/** Marks transactions this file built from the model, so the filter leaves them alone. */
const fromModel = Annotation.define<boolean>();
/** Asks the decorations to be rebuilt (comments changed). */
const refresh = StateEffect.define<null>();

export type StyleKey = "bold" | "italic" | "underline";

export class RichEditor {
	readonly view: EditorView;
	/** Style for the next typed characters, set by Ctrl+B etc. with nothing selected. */
	private pending: Style | null = null;

	constructor(private opts: RichEditorOptions) {
		const decorations = StateField.define<Decorations>({
			create: (state) => this.decorate(state.doc.toString(), opts.comments()),
			update: (value, tr) => {
				// Comment marks are re-read when asked; between times they move with the edits, by the
				// same rule the view uses for the saved comments (typing at either edge stays outside).
				if (tr.effects.some((e) => e.is(refresh))) return this.decorate(tr.newDoc.toString(), opts.comments());
				if (!tr.docChanged) return value;
				const comments = value.comments.map((c) => {
					const start = tr.changes.mapPos(Math.min(c.start, tr.changes.length), 1);
					return { ...c, start, end: Math.max(start, tr.changes.mapPos(Math.min(c.end, tr.changes.length), -1)) };
				});
				return this.decorate(tr.newDoc.toString(), comments);
			},
			provide: (f) => [EditorView.decorations.from(f, (v) => v.all), EditorView.atomicRanges.of((view) => view.state.field(f).markers)],
		});

		this.view = new EditorView({
			parent: opts.parent,
			state: EditorState.create({
				doc: opts.text,
				extensions: [
					decorations,
					history(),
					Prec.highest(
						EditorView.domEventHandlers({
							keydown: (e, view) => {
								// Ctrl+Shift+Z is redo everywhere (CodeMirror binds it only on Mac/Linux, and some
								// keyboards report a lowercase "z" that would match undo first).
								if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyZ") {
									e.preventDefault();
									redo(view);
									return true;
								}
								return opts.onKeydown(e);
							},
							copy: (e) => this.copy(e, false),
							cut: (e) => this.copy(e, true),
							paste: (e) => this.paste(e),
							// Selected text isn't dragged around (it would carry its hidden markers).
							dragstart: (e) => {
								e.preventDefault();
								return true;
							},
							// The plugin's own block drags pass straight through to the script.
							dragover: (e) => this.isIgnoredDrag(e),
							drop: (e) => this.isIgnoredDrag(e),
							focus: () => {
								opts.onFocus();
								return false;
							},
							blur: () => {
								opts.onBlur();
								return false;
							},
						})
					),
					keymap.of([
						{ key: "ArrowLeft", run: () => this.moveChar(false, false), shift: () => this.moveChar(false, true) },
						{ key: "ArrowRight", run: () => this.moveChar(true, false), shift: () => this.moveChar(true, true) },
						...historyKeymap,
						...standardKeymap,
					]),
					EditorView.lineWrapping,
					// CodeMirror owns its outer element's class list, so ours go through it.
					EditorView.editorAttributes.of({ class: opts.cls }),
					placeholderExt(opts.placeholder),
					EditorState.readOnly.of(opts.readOnly),
					EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", autocapitalize: "off", "aria-multiline": "true" }),
					EditorState.transactionFilter.of((tr) => this.filter(tr)),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange(u.state.doc.toString(), u.changes);
						// Moving the cursor anywhere forgets a style picked for the next characters.
						if (u.selectionSet && !u.docChanged && !u.transactions.some((t) => t.annotation(fromModel))) this.pending = null;
						if (u.selectionSet || u.focusChanged || u.docChanged) opts.onSelection();
					}),
				],
			}),
		});
	}

	get dom(): HTMLElement {
		return this.view.dom;
	}

	get text(): string {
		return this.view.state.doc.toString();
	}

	get selection(): { from: number; to: number } {
		const r = this.view.state.selection.main;
		return { from: r.from, to: r.to };
	}

	get hasFocus(): boolean {
		return this.view.hasFocus;
	}

	get readOnly(): boolean {
		return this.view.state.readOnly;
	}

	/** Focuses the field with the cursor at a raw offset (or its start/end). */
	focus(at?: number | "start" | "end") {
		this.view.focus();
		if (at === undefined) return;
		const len = this.view.state.doc.length;
		const pos = at === "start" ? 0 : at === "end" ? len : Math.max(0, Math.min(at, len));
		this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
	}

	/** The cursor is before all the text (hidden markers don't count). */
	caretAtStart(): boolean {
		const { from, to } = this.selection;
		return from === to && rawToPlain(toRich(this.text), from) === 0;
	}

	/** The cursor is after all the text (hidden markers don't count). */
	caretAtEnd(): boolean {
		const { from, to } = this.selection;
		const rich = toRich(this.text);
		return from === to && rawToPlain(rich, to) === rich.text.length;
	}

	/** ←/→: one visible character at a time, so hidden markers never take a key press. */
	private moveChar(forward: boolean, extend: boolean): boolean {
		const sel = this.view.state.selection.main;
		if (!extend && !sel.empty) {
			this.view.dispatch({ selection: EditorSelection.cursor(forward ? sel.to : sel.from), scrollIntoView: true, userEvent: "select" });
			return true;
		}
		const rich = toRich(this.text);
		const p = rawToPlain(rich, sel.head);
		const q = Math.max(0, Math.min(rich.text.length, p + (forward ? 1 : -1)));
		const pos = caretAfter(rich, q);
		this.view.dispatch({ selection: extend ? EditorSelection.range(sel.anchor, pos) : EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select" });
		return true;
	}

	/** Focuses the field with the cursor at a point on screen (where it was clicked). */
	focusAt(x: number, y: number) {
		const pos = this.view.posAtCoords({ x, y }) ?? this.view.state.doc.length;
		this.view.focus();
		this.view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
	}

	select(from: number, to: number) {
		const len = this.view.state.doc.length;
		this.view.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) } });
	}

	/** Screen box of a raw offset, or null when it isn't laid out. */
	coordsAt(pos: number): { left: number; right: number; top: number; bottom: number } | null {
		return this.view.coordsAtPos(Math.min(pos, this.view.state.doc.length), 1) ?? this.view.coordsAtPos(Math.min(pos, this.view.state.doc.length), -1);
	}

	/** Repaints comment marks (after comments are added, removed or selected). */
	refreshDecorations() {
		this.view.dispatch({ effects: refresh.of(null) });
	}

	destroy() {
		this.view.destroy();
	}

	// ---------------------------------------------------------------- formatting

	/** The style the selection has throughout (bold only if all of it is bold), or what typing would get. */
	selectionStyle(): Style {
		const rich = toRich(this.text);
		const { from, to } = this.selection;
		const pf = rawToPlain(rich, from);
		const pt = rawToPlain(rich, to);
		if (pf === pt) return this.pending ?? this.styleForTyping(rich, pf, pt);
		return commonStyle(rich.styles, pf, pt);
	}

	/** Ctrl+B / I / U: on the selected words, or for what's typed next if nothing is selected. */
	toggle(key: StyleKey) {
		if (this.readOnly) return;
		const on = !this.selectionStyle()[key];
		this.restyle((s) => ({ ...s, [key]: on }));
	}

	/** Highlights the selection in a colour, or clears its highlight with null. */
	setHighlight(color: HighlightColor | null) {
		if (this.readOnly) return;
		this.restyle((s) => ({ ...s, highlight: color }));
	}

	private restyle(change: (s: Style) => Style) {
		const raw = this.text;
		const rich = toRich(raw);
		const { from, to } = this.selection;
		const pf = rawToPlain(rich, from);
		const pt = rawToPlain(rich, to);
		if (pf === pt) {
			this.pending = change(this.pending ?? this.styleForTyping(rich, pf, pt));
			this.opts.onSelection();
			return;
		}
		const styles = rich.styles.map((s, k) => (k >= pf && k < pt && rich.text[k] !== "\n" ? change(s) : s));
		this.commit(raw, rich.text, styles, pf, pt, "input.format");
	}

	/** Writes the model back as one edit (its own undo step), selecting plain [selFrom, selTo) afterwards. */
	private commit(raw: string, text: string, styles: Style[], selFrom: number, selTo: number, userEvent: string) {
		const next = serialize(text, styles);
		const rich = toRich(next);
		const anchor = selFrom === selTo ? caretAfter(rich, selFrom) : charStart(next, rich, selFrom);
		const head = selFrom === selTo ? anchor : rich.at[selTo - 1] + 1;
		this.view.dispatch({
			changes: diffText(raw, next),
			selection: EditorSelection.single(anchor, head),
			annotations: [fromModel.of(true), Transaction.userEvent.of(userEvent), isolateHistory.of("full")],
			scrollIntoView: true,
		});
	}

	/** The style new text gets: what it replaces, else the character before it on the line, else the one after. */
	private styleForTyping(rich: Rich, pf: number, pt: number): Style {
		const { text, styles } = rich;
		if (pt > pf && text[pf] !== "\n") return styles[pf];
		if (pf > 0 && text[pf - 1] !== "\n") return styles[pf - 1];
		if (pt < text.length && text[pt] !== "\n") return styles[pt];
		return PLAIN;
	}

	// ---------------------------------------------------------------- edits go through the model

	private filter(tr: Transaction): Transaction | TransactionSpec {
		if (!tr.docChanged || tr.annotation(fromModel)) return tr;
		// Undo/redo restore earlier text exactly; IME composition is left to the browser.
		if (tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("input.type.compose")) return tr;
		const userEvent = tr.annotation(Transaction.userEvent);
		if (!userEvent) return tr; // the plugin's own edits are already in marker form

		const raw = tr.startState.doc.toString();
		const rich = toRich(raw);
		let text = rich.text;
		let styles = rich.styles.slice();
		const edits: { pf: number; pt: number; insert: string }[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			let pf = rawToPlain(rich, fromA);
			let pt = rawToPlain(rich, toA);
			// Deleting only hidden markers deletes the character next to them instead.
			if (pf === pt && toA > fromA && !inserted.length) {
				if (tr.isUserEvent("delete.backward") && pf > 0) pf--;
				else if (tr.isUserEvent("delete.forward") && pt < text.length) pt++;
			}
			edits.push({ pf, pt, insert: inserted.toString() });
		});
		let caret = 0;
		// Apply from the end so earlier positions stay valid.
		for (let i = edits.length - 1; i >= 0; i--) {
			const { pf, pt, insert } = edits[i];
			const style = this.pending ?? this.styleForTyping({ text, styles, at: [] }, pf, pt);
			text = text.slice(0, pf) + insert + text.slice(pt);
			styles = [...styles.slice(0, pf), ...Array.from(insert, (ch) => (ch === "\n" ? PLAIN : style)), ...styles.slice(pt)];
			if (i === edits.length - 1) caret = pf + insert.length;
			else caret += insert.length - (pt - pf);
		}
		if (edits.some((e) => e.insert.length)) this.pending = null;

		const next = serialize(text, styles);
		const nextRich = toRich(next);
		const pos = caretAfter(nextRich, Math.max(0, Math.min(caret, text.length)));
		return {
			changes: diffText(raw, next),
			selection: EditorSelection.cursor(pos),
			annotations: [fromModel.of(true), Transaction.userEvent.of(userEvent)],
			scrollIntoView: true,
		};
	}

	// ---------------------------------------------------------------- clipboard

	/** Copies the words as they read, plus a formatted copy for pasting into another block. */
	private copy(e: ClipboardEvent, cut: boolean): boolean {
		const { from, to } = this.selection;
		if (from === to || !e.clipboardData) return false;
		const raw = this.text;
		const rich = toRich(raw);
		const pf = rawToPlain(rich, from);
		const pt = rawToPlain(rich, to);
		e.clipboardData.setData("text/plain", rich.text.slice(pf, pt));
		e.clipboardData.setData(this.opts.clipboardType, serialize(rich.text.slice(pf, pt), rich.styles.slice(pf, pt)));
		e.preventDefault();
		if (cut && !this.readOnly) {
			this.commit(raw, rich.text.slice(0, pf) + rich.text.slice(pt), [...rich.styles.slice(0, pf), ...rich.styles.slice(pt)], pf, pf, "delete.cut");
		}
		return true;
	}

	/** Formatted text copied from another block keeps its formatting; anything else is pasted as plain text. */
	private paste(e: ClipboardEvent): boolean {
		const formatted = e.clipboardData?.getData(this.opts.clipboardType);
		if (!formatted || this.readOnly) return false;
		e.preventDefault();
		const raw = this.text;
		const rich = toRich(raw);
		const add = toRich(formatted);
		const { from, to } = this.selection;
		const pf = rawToPlain(rich, from);
		const pt = rawToPlain(rich, to);
		const text = rich.text.slice(0, pf) + add.text + rich.text.slice(pt);
		const styles = [...rich.styles.slice(0, pf), ...add.styles, ...rich.styles.slice(pt)];
		const end = pf + add.text.length;
		this.commit(raw, text, styles, end, end, "input.paste");
		return true;
	}

	private isIgnoredDrag(e: DragEvent): boolean {
		const types = Array.from(e.dataTransfer?.types ?? []);
		return this.opts.ignoreDragTypes.some((t) => types.includes(t));
	}

	// ---------------------------------------------------------------- display

	/** Hidden markers (also atomic, so the cursor steps over them), styled text and comment marks. */
	private decorate(raw: string, comments: CommentSpan[]): Decorations {
		const hide = Decoration.replace({});
		const marks = [];
		const markers = [];
		let pos = 0;
		for (const seg of parseInline(raw)) {
			const end = pos + seg.text.length;
			if (seg.marker) markers.push(hide.range(pos, end));
			else if (seg.bold || seg.italic || seg.underline || seg.highlight) {
				const cls = [seg.bold && "st-b", seg.italic && "st-i", seg.underline && "st-u", seg.highlight && `st-mark st-mark-${seg.highlight}`].filter(Boolean).join(" ");
				marks.push(Decoration.mark({ class: cls }).range(pos, end));
			}
			pos = end;
		}
		for (const c of comments) {
			const start = Math.max(0, Math.min(c.start, raw.length));
			const end = Math.max(start, Math.min(c.end, raw.length));
			if (end > start) marks.push(Decoration.mark({ class: "st-cmt" + (c.active ? " is-active" : "") }).range(start, end));
		}
		return { all: Decoration.set([...markers, ...marks], true), markers: Decoration.set(markers, true), comments };
	}
}
