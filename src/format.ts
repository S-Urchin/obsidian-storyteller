/*
 * Inline formatting, shared by the editor preview and the Word export so they always agree.
 *
 *   ***bold italic***   **bold**   *italic*   __underline__   ==highlight==
 *
 * Highlights come in colours too: =g=green=g=  =b=blue=b=  =p=pink=p=  =o=orange=o=
 * (plain == is yellow, same as before).
 *
 * Markers don't nest (except *** for bold italic) and don't span lines, which keeps
 * the rules predictable while typing.
 */

import { HighlightColor } from "./types";

export interface Segment {
	text: string;
	/** A formatting marker (**, ==, …): faded in the editor, dropped from the export. */
	marker: boolean;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	highlight?: HighlightColor;
}

/** The marker text wrapped around highlighted text, one per colour. */
export const HIGHLIGHT_MARKERS: Record<HighlightColor, string> = {
	yellow: "==",
	green: "=g=",
	blue: "=b=",
	pink: "=p=",
	orange: "=o=",
};

const MARKER_TO_HIGHLIGHT: Record<string, HighlightColor> = Object.fromEntries(
	Object.entries(HIGHLIGHT_MARKERS).map(([color, marker]) => [marker, color])
) as Record<string, HighlightColor>;

// Longest first, so "=g=" etc. aren't shadowed by the shorter "==" alternative.
const ALL_MARKERS = ["***", "**", "*", "__", ...Object.values(HIGHLIGHT_MARKERS)].sort((a, b) => b.length - a.length);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const highlightAlternatives = Object.values(HIGHLIGHT_MARKERS)
	.map((m) => `${escapeRe(m)}[^=\\n]+?${escapeRe(m)}`)
	.join("|");
const TOKEN = new RegExp(`(\\*\\*\\*[^*\\n]+?\\*\\*\\*|\\*\\*[^*\\n]+?\\*\\*|\\*[^*\\n]+?\\*|__[^_\\n]+?__|${highlightAlternatives})`, "g");

export function parseInline(text: string): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	TOKEN.lastIndex = 0;
	while ((m = TOKEN.exec(text))) {
		if (m.index > last) out.push({ text: text.slice(last, m.index), marker: false });
		const tok = m[0];
		const mark = ALL_MARKERS.find((mk) => tok.startsWith(mk))!;
		const n = mark.length;
		const style: Partial<Segment> =
			mark === "***" ? { bold: true, italic: true }
			: mark === "**" ? { bold: true }
			: mark === "*" ? { italic: true }
			: mark === "__" ? { underline: true }
			: { highlight: MARKER_TO_HIGHLIGHT[mark] };
		out.push({ text: mark, marker: true }, { text: tok.slice(n, -n), marker: false, ...style }, { text: mark, marker: true });
		last = m.index + tok.length;
	}
	if (last < text.length) out.push({ text: text.slice(last), marker: false });
	return out;
}

/** Words with a comment on them, as offsets into the raw text. */
export interface CommentSpan {
	start: number;
	end: number;
	active?: boolean;
}

/** Splits the text into segments with their offsets, cut wherever a comment starts or ends. */
export function cutSegments(text: string, spans: CommentSpan[]): { seg: Segment; from: number; to: number }[] {
	const out: { seg: Segment; from: number; to: number }[] = [];
	let pos = 0;
	for (const seg of parseInline(text)) {
		const end = pos + seg.text.length;
		const cuts = [pos, end];
		for (const s of spans) for (const c of [s.start, s.end]) if (c > pos && c < end) cuts.push(c);
		cuts.sort((a, b) => a - b);
		for (let i = 0; i < cuts.length - 1; i++) {
			if (cuts[i] === cuts[i + 1]) continue;
			out.push({ seg: { ...seg, text: text.slice(cuts[i], cuts[i + 1]) }, from: cuts[i], to: cuts[i + 1] });
		}
		pos = end;
	}
	return out;
}

/** Renders text as styled spans (markers included, faded) for the editor's live preview. */
export function renderInline(parent: HTMLElement, text: string, comments: CommentSpan[] = []) {
	parent.empty();
	for (const { seg, from, to } of cutSegments(text, comments)) {
		const on = comments.filter((c) => c.start < c.end && c.start <= from && c.end >= to);
		if (!seg.marker && !seg.bold && !seg.italic && !seg.underline && !seg.highlight && !on.length) {
			parent.appendText(seg.text);
			continue;
		}
		const span = parent.createSpan({ text: seg.text });
		if (seg.marker) span.addClass("st-md");
		if (seg.bold) span.addClass("st-b");
		if (seg.italic) span.addClass("st-i");
		if (seg.underline) span.addClass("st-u");
		if (seg.highlight) span.addClass("st-mark", "st-mark-" + seg.highlight);
		if (on.length) span.addClass("st-cmt");
		if (on.some((c) => c.active)) span.addClass("is-active");
	}
	// A trailing newline needs content after it, or the preview is a line short of the text box.
	if (text.endsWith("\n") || !text) parent.appendText("​");
}

export type Marker = "**" | "*" | "__";

/** Counts how many `ch` characters run up to the end of `s` (or from its start). */
function runAtEnd(s: string, ch: string) {
	let n = 0;
	while (n < s.length && s[s.length - 1 - n] === ch) n++;
	return n;
}
function runAtStart(s: string, ch: string) {
	let n = 0;
	while (n < s.length && s[n] === ch) n++;
	return n;
}

/** Whether `count` asterisks on both sides include the given * marker (handles *** = bold + italic). */
function starsInclude(before: number, after: number, marker: Marker) {
	const has = (k: number) => (marker === "**" ? k >= 2 : k % 2 === 1);
	return has(before) && has(after);
}

export interface Edit {
	/** Replace value[from, to) with `insert`, then select [selStart, selEnd). */
	from: number;
	to: number;
	insert: string;
	selStart: number;
	selEnd: number;
}

/**
 * Works out the edit that toggles `marker` around the selection [start, end):
 * - already wrapped (markers just outside, or inside the selection) → unwrap
 * - otherwise wrap; surrounding spaces stay outside the markers
 * - empty selection → insert a pair and put the caret between them
 */
export function toggleMarker(value: string, start: number, end: number, marker: Marker): Edit {
	const L = marker.length;
	const star = marker[0] === "*";

	// Keep leading/trailing spaces outside the markers (markdown-style rules).
	let s = start;
	let e = end;
	while (s < e && /\s/.test(value[s])) s++;
	while (e > s && /\s/.test(value[e - 1])) e--;

	if (s === e) {
		return { from: start, to: end, insert: value.slice(start, end) + marker + marker, selStart: end + L, selEnd: end + L };
	}

	const before = value.slice(0, s);
	const after = value.slice(e);
	const sel = value.slice(s, e);

	// Markers just outside the selection.
	const outside = star
		? starsInclude(runAtEnd(before, "*"), runAtStart(after, "*"), marker)
		: before.endsWith(marker) && after.startsWith(marker);
	if (outside) {
		return { from: s - L, to: e + L, insert: sel, selStart: s - L, selEnd: e - L };
	}

	// Markers selected along with the text.
	const inside = star
		? sel.length > 2 * L && starsInclude(runAtStart(sel, "*"), runAtEnd(sel, "*"), marker)
		: sel.length > 2 * L && sel.startsWith(marker) && sel.endsWith(marker);
	if (inside) {
		const inner = sel.slice(L, sel.length - L);
		return { from: s, to: e, insert: inner, selStart: s, selEnd: s + inner.length };
	}

	return { from: s, to: e, insert: marker + sel + marker, selStart: s + L, selEnd: e + L };
}

/** Finds a highlight marker (of any colour) wrapped around, or just outside, the selection. */
function findHighlightSpan(value: string, start: number, end: number): { color: HighlightColor; from: number; to: number; inner: string } | null {
	let s = start;
	let e = end;
	while (s < e && /\s/.test(value[s])) s++;
	while (e > s && /\s/.test(value[e - 1])) e--;
	if (s === e) return null;

	const before = value.slice(0, s);
	const after = value.slice(e);
	const sel = value.slice(s, e);

	for (const [color, m] of Object.entries(HIGHLIGHT_MARKERS) as [HighlightColor, string][]) {
		if (before.endsWith(m) && after.startsWith(m)) return { color, from: s - m.length, to: e + m.length, inner: sel };
		if (sel.length > 2 * m.length && sel.startsWith(m) && sel.endsWith(m)) return { color, from: s, to: e, inner: sel.slice(m.length, sel.length - m.length) };
	}
	return null;
}

/** The highlight colour (if any) currently applied to the selection. */
export function detectHighlight(value: string, start: number, end: number): HighlightColor | null {
	return findHighlightSpan(value, start, end)?.color ?? null;
}

/**
 * Works out the edit that sets the selection's highlight to `color` (or clears it if null),
 * replacing any existing highlight colour it already had. Mirrors toggleMarker's whitespace
 * and empty-selection handling.
 */
export function setHighlight(value: string, start: number, end: number, color: HighlightColor | null): Edit {
	let s = start;
	let e = end;
	while (s < e && /\s/.test(value[s])) s++;
	while (e > s && /\s/.test(value[e - 1])) e--;

	if (s === e) {
		if (!color) return { from: start, to: end, insert: value.slice(start, end), selStart: start, selEnd: end };
		const marker = HIGHLIGHT_MARKERS[color];
		return { from: start, to: end, insert: value.slice(start, end) + marker + marker, selStart: end + marker.length, selEnd: end + marker.length };
	}

	const span = findHighlightSpan(value, start, end);
	const from = span?.from ?? s;
	const to = span?.to ?? e;
	const inner = span?.inner ?? value.slice(s, e);

	if (!color) return { from, to, insert: inner, selStart: from, selEnd: from + inner.length };

	const marker = HIGHLIGHT_MARKERS[color];
	return { from, to, insert: marker + inner + marker, selStart: from + marker.length, selEnd: from + marker.length + inner.length };
}

// ---------------------------------------------------------------- [[wiki links]]

export const LINK = /\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/** What a [[link]] shows as text: its alias, else the note name (plus " > heading"). */
export function linkShown(path: string, hash: string | undefined, alias: string | undefined): string {
	if (alias) return alias;
	const name = path.split("/").pop() || path;
	return hash ? `${name} > ${hash.slice(1)}` : name;
}

/** Plain text with links replaced by what they display (for the Word export). */
export function linksToText(text: string): string {
	return text.replace(LINK, (_m, path: string, hash?: string, alias?: string) => linkShown(path, hash, alias));
}
