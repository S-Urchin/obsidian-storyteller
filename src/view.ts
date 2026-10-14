import { Menu, MenuItem, Modifier, Notice, Scope, TextFileView, WorkspaceLeaf, setIcon } from "obsidian";
import type StorytellerPlugin from "./main";
import {
	balloonNumbers,
	blockFromPreset,
	cloneWithNewIds,
	collectSpeakers,
	describeRef,
	findRef,
	findType,
	freeFormat,
	isLocked,
	newBlock,
	newDoc,
	newPage,
	newPanel,
	normalizeDoc,
	pageLabel,
	panelLabel,
	panelLetteringWords,
	uid,
	walk,
	wordCount,
} from "./doc";
import { MAX_PALETTE, MIN_PALETTE, VIEW_TYPE_COMIC, WIDE_PALETTE } from "./defaults";
import { BlockTypeModal, ConfirmModal, HelpModal, HelpTab, PageChoice, PagePickerModal, PromptModal } from "./modals";
import { cutSegments, parseInline, rawToPlain, toRich } from "./format";
import { CommentSpan, RichEditor, StyleKey } from "./rich-editor";
import { LinkSuggest, renderLinked } from "./links";
import { exportFolderLabel, isSystemPath, shortPath } from "./locations";
import { animateRender, capturePositions, motionAllowed, playOnce } from "./motion";
import { ensureSections, isStarred, moveToSection, newSection, presetKey, starredItems, toggleStar, typeKey } from "./palette";
import { Block, BlockPreset, BlockType, ComicDoc, FreeFormat, HighlightColor, HIGHLIGHT_COLORS, ItemKind, ItemRef, NoteRange, NoteReply, Page, PaletteSection, Panel, PaperMode, SideNote } from "./types";

type DragPayload =
	| { kind: "page" | "panel" | "block"; id: string }
	| { kind: "new-page" }
	| { kind: "new-panel" }
	| { kind: "new-block"; typeId: string }
	| { kind: "preset"; presetId: string };

type ZoneKind = "pages" | "panels" | "blocks";

const ACCEPTS: Record<ZoneKind, DragPayload["kind"][]> = {
	pages: ["page", "new-page"],
	panels: ["panel", "new-panel"],
	blocks: ["block", "new-block", "preset"],
};

type SideTab = "pinned" | "revisions";

const MAX_UNDO = 200;
/** Private drag type: text fields ignore it, so a drop can never insert text into them. */
const DRAG_MIME = "application/x-storyteller";
/** Clipboard type for formatted text copied between blocks. */
const CLIP_MIME = "application/x-storyteller-text";
/**
 * Keys the view claims while it's active. Block text uses CodeMirror, like Obsidian's own editor,
 * so Obsidian's editor hotkeys (Ctrl+B, Ctrl+I, Ctrl+Enter, Ctrl+E…) would otherwise take them first.
 */
const VIEW_KEYS: [Modifier[], string][] = [
	[["Mod"], "b"],
	[["Mod"], "i"],
	[["Mod"], "u"],
	[["Mod"], "Enter"],
	[["Mod", "Shift"], "Enter"],
	[["Mod", "Shift"], "h"],
	[["Mod", "Alt"], "m"],
	[["Mod"], "e"],
];
/** Distance from the top/bottom edge of the script at which dragging scrolls it. */
const SCROLL_EDGE = 70;

/** Where a drop would land, worked out from the pointer position. */
interface DropPlan {
	kind: ZoneKind;
	container: Page | Panel | null;
	index: number;
	/** The list to show the insertion line in, or null when dropping onto a collapsed page/panel. */
	zone: HTMLElement | null;
	/** Page or panel that receives the drop (highlighted when collapsed). */
	target: HTMLElement | null;
}
const CARD_GAP = 8;
/** Comment and reply text longer than this many lines is folded behind "Show more". */
const FOLD_LINES = 4;

export class ComicView extends TextFileView {
	doc: ComicDoc;
	private loadError: string | null = null;

	private undoStack: string[] = [];
	private redoStack: string[] = [];
	/** Snapshot taken when a text field gains focus; pushed to undo on the first keystroke. */
	private pendingSnapshot: string | null = null;

	private drag: DragPayload | null = null;
	/** What the quick-add rows were last drawn from, so palette edits that change them also redraw the script. */
	private quickAddDrawn = "";
	private indicator: HTMLElement | null = null;
	/** Insertion line over the pages list; overlaid so the list never shifts under the pointer. */
	private navLine: HTMLElement | null = null;
	/** The export folder menu while it's open, and when it last closed (see exportButton). */
	private exportMenu: Menu | null = null;
	private exportMenuClosedAt = 0;

	private narrow = false;
	private paletteOpen = true;
	private paletteWide = false;
	/** Read mode: the finished script, laid out like the Word export, with no editing chrome. */
	private readMode = false;

	// Text editors (one per block), and the formatting bar that appears over a selection.
	private editors = new Set<RichEditor>();
	/** Each editor by its outer element, and the block it edits. */
	private editorOf = new WeakMap<HTMLElement, RichEditor>();
	private editorBlocks = new WeakMap<RichEditor, Block>();
	private editorRefs = new WeakMap<RichEditor, { ref: ItemRef; type: BlockType }>();
	/** Block text not yet turned into an editor: how to make it one, and the block it shows. */
	private mounters = new WeakMap<HTMLElement, () => RichEditor>();
	private staticBlocks = new WeakMap<HTMLElement, Block>();
	private formatBar: HTMLElement | null = null;
	private highlightPopover: HTMLElement | null = null;
	private formatTarget: RichEditor | null = null;
	/** After a re-render, focus this field inside the focused item instead of its first field. */
	private focusSelector: string | null = null;
	private focusCaret: number | null = null;

	// Status feedback.
	private saveState: "saved" | "dirty" | "saving" = "saved";
	private saveEl: HTMLElement | null = null;
	private undoBtn: HTMLButtonElement | null = null;
	private redoBtn: HTMLButtonElement | null = null;

	// Motion: what was on screen last render, and where, so only changes animate.
	private shownItems: Set<string> | null = null;
	private shownCards: Set<string> | null = null;
	private shownPalette: Set<string> | null = null;
	private flipFrom: Map<string, number> | null = null;
	private sideOpen = false;
	private sideTab: SideTab = "pinned";
	private activePanelId: string | null = null;
	private focusAfterRender: string | null = null;

	// Comment margin (Google Docs style).
	private marginOpen = true;
	private showResolved = false;
	private draftTarget: string | null = null;
	/** Set when the draft comment is on selected words rather than the whole item. */
	private draftRange: NoteRange | null = null;
	/** Unsent reply text per comment. */
	private replyDrafts = new Map<string, string>();
	/** Comments and replies opened with "Show more". */
	private expandedText = new Set<string>();
	private editingNote: string | null = null;
	private activeNote: string | null = null;
	private marginEl: HTMLElement | null = null;
	private sheetObserver: ResizeObserver | null = null;
	private layoutQueued = false;

	private paletteEl: HTMLElement;
	private navEl: HTMLElement | null = null;
	private navActiveId: string | null = null;
	private navSpyQueued = false;
	private navLockUntil = 0;
	private navRefreshTimer: number | null = null;
	private scriptEl: HTMLElement;
	private sideEl: HTMLElement;
	private statsEl: HTMLElement;
	private datalistId = "st-speakers-" + uid();
	private datalistEl: HTMLDataListElement;
	private panelCountEls = new Map<string, HTMLElement>();

	constructor(leaf: WorkspaceLeaf, private plugin: StorytellerPlugin) {
		super(leaf);
		this.doc = newDoc(plugin.settings, "Untitled");
		this.scope = new Scope(this.app.scope);
		for (const [mods, key] of VIEW_KEYS) this.scope.register(mods, key, (evt) => this.viewKey(evt));
		// Show "Edited" as soon as anything changes; Obsidian saves a moment later.
		const debounced = this.requestSave;
		this.requestSave = () => {
			this.setSaveState("dirty");
			debounced.call(this);
		};
	}

	async save(clear?: boolean) {
		this.setSaveState("saving");
		await super.save(clear);
		this.setSaveState("saved");
	}

	private setSaveState(state: "saved" | "dirty" | "saving") {
		this.saveState = state;
		const el = this.saveEl;
		if (!el) return;
		el.setText(state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Edited");
		el.dataset.state = state;
		el.setAttr("aria-label", state === "saved" ? "All changes saved to the file" : "Changes will be saved in a moment");
	}

	private updateHistoryButtons() {
		this.undoBtn?.toggleClass("is-disabled", !this.undoStack.length);
		this.redoBtn?.toggleClass("is-disabled", !this.redoStack.length);
		if (this.undoBtn) this.undoBtn.disabled = !this.undoStack.length;
		if (this.redoBtn) this.redoBtn.disabled = !this.redoStack.length;
	}

	/** A notice with an Undo button: deleting is quick, and so is taking it back. */
	private undoNotice(message: string) {
		const frag = createFragment((f) => {
			f.appendText(message + "  ");
			f.createEl("button", { cls: "st-notice-undo", text: "Undo" }).addEventListener("click", (e) => {
				e.stopPropagation();
				this.undo();
			});
		});
		new Notice(frag, 7000);
	}

	getViewType() {
		return VIEW_TYPE_COMIC;
	}

	getIcon() {
		return "book-open";
	}

	getDisplayText() {
		return this.file?.basename ?? "Comic script";
	}

	// ---------------------------------------------------------------- file I/O

	getViewData(): string {
		if (this.loadError !== null) return this.loadError;
		return JSON.stringify(this.doc, null, 2);
	}

	setViewData(data: string, clear: boolean): void {
		const title = this.file?.basename ?? "Untitled";
		this.loadError = null;
		if (!data.trim()) {
			this.doc = newDoc(this.plugin.settings, title);
		} else {
			try {
				this.doc = normalizeDoc(JSON.parse(data), title);
				if (this.migrateNoteBlocks()) this.requestSave();
			} catch {
				// Keep the raw text so a broken file is never overwritten.
				this.loadError = data;
			}
		}
		if (clear) {
			this.undoStack = [];
			this.redoStack = [];
			this.shownItems = null;
			this.shownCards = null;
			this.draftTarget = null;
			this.draftRange = null;
			this.editingNote = null;
			this.activeNote = null;
		}
		this.renderAll();
	}

	/** Scripts from v1 had "Note to artist" blocks; those are now comments on their panel. */
	private migrateNoteBlocks(): boolean {
		if (this.plugin.settings.blockTypes.some((t) => t.id === "note")) return false;
		let changed = false;
		for (const page of this.doc.pages) {
			for (const panel of page.panels) {
				const notes = panel.blocks.filter((b) => b.typeId === "note");
				if (!notes.length) continue;
				changed = true;
				for (const b of notes) {
					if (b.text.trim()) {
						panel.notes.push({ id: uid(), text: b.text.trim(), author: this.plugin.settings.authorName, created: Date.now(), resolved: false, replies: [] });
					}
				}
				panel.blocks = panel.blocks.filter((b) => b.typeId !== "note");
			}
		}
		return changed;
	}

	clear(): void {
		this.doc = newDoc(this.plugin.settings, "Untitled");
		this.undoStack = [];
		this.redoStack = [];
	}

	async onOpen() {
		this.contentEl.addClass("st-root");
		// Focusable itself, so leaving a field (Esc) or clicking empty space keeps keyboard
		// shortcuts (Ctrl+Z, Ctrl+/) inside this view instead of losing them to the page.
		this.contentEl.tabIndex = -1;
		this.contentEl.addEventListener("keydown", (e) => this.onKeydown(e));
		this.registerDomEvent(window, "dragend", () => this.endDrag());
		// Obsidian's light/dark switch: Auto paper recolours via CSS; keep the sun/moon icon in step.
		this.registerEvent(this.app.workspace.on("css-change", () => this.updatePaperIcon()));
		// Over the toolbar or other dead areas: hide the insertion line so it never promises a drop that won't happen.
		this.contentEl.addEventListener("dragover", (e) => {
			if (this.drag && !(e.target as HTMLElement).closest(".st-script, .st-palette, .st-nav")) this.clearDropHint();
		});
	}

	async onClose() {
		this.sheetObserver?.disconnect();
		this.destroyEditors();
	}

	onResize() {
		// On first becoming narrow, close the side columns: they'd otherwise float over the script.
		const width = this.contentEl.clientWidth;
		const narrow = width > 0 && width <= 900;
		if (narrow && !this.narrow && (this.paletteOpen || this.sideOpen)) {
			this.narrow = narrow;
			this.paletteOpen = false;
			this.sideOpen = false;
			this.renderAll();
			return;
		}
		if (width > 0) this.narrow = narrow;
		this.queueLayout();
	}

	// ---------------------------------------------------------------- history

	private snapshot() {
		this.undoStack.push(JSON.stringify(this.doc));
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
		this.updateHistoryButtons();
	}

	/** Runs a change to the document, records undo, saves and re-renders. */
	mutate(fn: () => void, render = true) {
		this.snapshot();
		if (render) this.capture();
		fn();
		this.requestSave();
		if (render) this.renderAll();
	}

	private get motion(): boolean {
		return motionAllowed(this.plugin.settings.animations);
	}

	/** Records item positions so the next render can glide them to their new places. */
	private capture() {
		if (!this.motion || !this.scriptEl) return;
		this.flipFrom = capturePositions(Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet [data-id]")), (el) => el.dataset.id);
	}

	private animateScript() {
		const from = this.flipFrom;
		this.flipFrom = null;
		const els = Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet [data-id]"));
		const motion = this.motion;
		this.shownItems = animateRender(
			els,
			(el) => el.dataset.id,
			motion ? this.shownItems : null,
			motion ? from : null,
			(el) => el.parentElement?.closest<HTMLElement>("[data-id]")?.dataset.id
		);
	}

	undo() {
		const prev = this.undoStack.pop();
		if (!prev) return new Notice("Nothing to undo");
		this.redoStack.push(JSON.stringify(this.doc));
		this.capture();
		this.doc = JSON.parse(prev) as ComicDoc;
		this.hideFormatBar();
		this.requestSave();
		this.renderAll();
	}

	redo() {
		const next = this.redoStack.pop();
		if (!next) return new Notice("Nothing to redo");
		this.undoStack.push(JSON.stringify(this.doc));
		this.capture();
		this.doc = JSON.parse(next) as ComicDoc;
		this.requestSave();
		this.renderAll();
	}

	// ---------------------------------------------------------------- pages panel

	/** Pages list: click to jump, drag to reorder, collapses to a rail of numbers. */
	private renderNav() {
		const el = this.navEl;
		if (!el) return;
		const s = this.plugin.settings;
		const collapsed = s.pageNavCollapsed;
		el.empty();

		const head = el.createDiv("st-nav-head");
		if (!collapsed) {
			head.createSpan({ cls: "st-nav-title", text: "Pages" });
			head.createSpan({ cls: "st-nav-count", text: String(this.doc.pages.length) });
		}
		this.iconBtn(head, collapsed ? "chevrons-right" : "chevrons-left", collapsed ? "Expand page list" : "Collapse page list", () => this.setNavCollapsed(!collapsed), "st-nav-toggle");

		if (!collapsed && this.doc.pages.length > 6) {
			const go = el.createEl("input", { cls: "st-nav-goto", attr: { type: "text", inputmode: "numeric", placeholder: "Go to page #", "aria-label": "Go to page number" } });
			go.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					const n = parseInt(go.value, 10);
					const page = this.doc.pages[n - 1];
					if (page) this.navTo(page.id);
					else new Notice(`There are ${this.doc.pages.length} pages.`);
					go.select();
				} else if (e.key === "Escape") {
					go.value = "";
					go.blur();
				}
			});
		}

		// Per-page status, gathered in one pass.
		const status = new Map<string, { revision: boolean; notes: number; pinned: boolean }>();
		for (const ref of walk(this.doc)) {
			const st = status.get(ref.page.id) ?? { revision: false, notes: 0, pinned: false };
			st.revision ||= ref.item.revision;
			st.pinned ||= ref.item.pinned;
			st.notes += ref.item.notes.filter((n) => !n.resolved).length;
			status.set(ref.page.id, st);
		}

		const list = el.createDiv("st-nav-list");
		this.doc.pages.forEach((page, i) => {
			const st = status.get(page.id) ?? { revision: false, notes: 0, pinned: false };
			const snippet = this.pageSnippet(page);
			const n = page.panels.length;
			const summary = `${pageLabel(i, s.pageNumberStyle)} · ${n} panel${n === 1 ? "" : "s"}` + (st.revision ? " · needs revision" : "") + (st.notes ? ` · ${st.notes} comment${st.notes === 1 ? "" : "s"}` : "");
			const item = list.createDiv({
				cls: "st-nav-item",
				attr: { "data-page": page.id, "data-drag-item": "", role: "button", tabindex: "0", "aria-label": summary + (snippet ? ` — ${snippet}` : "") },
			});
			if (collapsed) item.setAttr("data-tooltip-position", "right");
			const num = item.createDiv({ cls: "st-nav-num", text: String(i + 1) });
			num.toggleClass("has-revision", st.revision);
			num.toggleClass("has-notes", st.notes > 0);

			if (!collapsed) {
				const detail = item.createDiv("st-nav-detail");
				const label = detail.createDiv("st-nav-label");
				label.createSpan({ text: `Page ${i + 1}` });
				label.createSpan({ cls: "st-nav-meta", text: `${n} panel${n === 1 ? "" : "s"}` });
				if (st.pinned || page.locked) {
					const flags = label.createSpan("st-nav-flags");
					if (st.pinned) setIcon(flags.createSpan({ attr: { "aria-label": "Has pinned items" } }), "pin");
					if (page.locked) setIcon(flags.createSpan({ attr: { "aria-label": "Locked" } }), "lock");
				}
				detail.createDiv({ cls: "st-nav-snippet" + (snippet ? "" : " is-empty"), text: snippet || "No description yet" });
			}

			item.addEventListener("click", () => this.navTo(page.id));
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.itemMenu(e, { kind: "page", item: page, page, pageIndex: i });
			});
			item.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					this.navTo(page.id);
				} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					const sib = (e.key === "ArrowDown" ? item.nextElementSibling : item.previousElementSibling) as HTMLElement | null;
					sib?.focus();
				}
			});
			if (!page.locked && !this.readMode) {
				item.setAttr("draggable", "true");
				item.addEventListener("dragstart", (e) => this.startDrag(e, { kind: "page", id: page.id }, item));
			}
		});
		if (!this.doc.pages.length) list.createDiv({ cls: "st-palette-empty", text: "No pages yet." });

		if (!collapsed && !this.readMode) {
			const add = el.createEl("button", { cls: "st-nav-add st-plus", text: "Add page" });
			add.addEventListener("click", () => this.addPage());
		}

		// Drag pages within the list to reorder them.
		list.addEventListener("dragover", (e) => {
			if (!this.drag || (this.drag.kind !== "page" && this.drag.kind !== "new-page")) return;
			e.preventDefault();
			this.setDropEffect(e);
			this.autoScrollNav(list, e.clientY);
			this.indicator?.remove();
			this.showNavLine(this.dropIndex(list, e.clientY));
		});
		list.addEventListener("drop", (e) => {
			if (!this.drag || (this.drag.kind !== "page" && this.drag.kind !== "new-page")) return;
			e.preventDefault();
			const index = this.dropIndex(list, e.clientY);
			const payload = this.drag;
			this.endDrag();
			this.performDrop("pages", null, index, payload);
		});

		this.navActiveId = null;
		this.updateNavActive();
	}

	/** "Swap with page\u2026" / "Move to position\u2026": pick the other page from a list instead of a long drag. */
	pickPage(pageId: string, action: "swap" | "move") {
		const pages = this.doc.pages;
		const from = pages.findIndex((p) => p.id === pageId);
		if (from < 0) return;
		if (pages[from].locked) return new Notice("This page is locked. Unlock it to move it.");
		const choices: PageChoice[] = pages.map((p, j) => ({
			index: j,
			label: `Page ${j + 1}`,
			detail: this.pageSnippet(p) || `${p.panels.length} panel${p.panels.length === 1 ? "" : "s"}, no description yet`,
			disabled: j === from ? "this page" : action === "swap" && p.locked ? "locked" : undefined,
		}));
		const title = action === "swap" ? `Swap page ${from + 1} with\u2026` : `Move page ${from + 1} to position\u2026`;
		new PagePickerModal(this.app, title, choices, (to) => (action === "swap" ? this.swapPages(from, to) : this.movePage(from, to))).open();
	}

	/** Command-palette version: acts on the page currently highlighted in the Pages list. */
	pickCurrentPage(action: "swap" | "move") {
		const id = this.navActiveId ?? this.doc.pages[0]?.id;
		if (id) this.pickPage(id, action);
	}

	private swapPages(a: number, b: number) {
		const pages = this.doc.pages;
		const pa = pages[a];
		const pb = pages[b];
		if (!pa || !pb || a === b) return;
		this.mutate(() => {
			pages[a] = pb;
			pages[b] = pa;
		});
		this.undoNotice(`Swapped pages ${a + 1} and ${b + 1}.`);
		this.afterPageMove([pa.id, pb.id]);
	}

	private movePage(from: number, to: number) {
		const pages = this.doc.pages;
		if (from === to || !pages[from]) return;
		const moved = pages[from];
		this.mutate(() => pages.splice(to, 0, pages.splice(from, 1)[0]));
		this.undoNotice(`Moved page ${from + 1} to position ${to + 1}.`);
		this.afterPageMove([moved.id]);
	}

	/** Briefly marks the pages that moved, and keeps the first one in view. */
	private afterPageMove(ids: string[]) {
		window.requestAnimationFrame(() => {
			ids.forEach((id) => {
				const el = this.scriptEl?.querySelector<HTMLElement>(`.st-sheet [data-id="${id}"]`);
				if (el && this.motion) playOnce(el, "st-flash");
				const item = this.navEl?.querySelector<HTMLElement>(`.st-nav-item[data-page="${id}"]`);
				if (item && this.motion) playOnce(item, "st-nav-flash");
			});
		});
	}

	private setNavCollapsed(collapsed: boolean) {
		this.plugin.settings.pageNavCollapsed = collapsed;
		this.navEl?.parentElement?.toggleClass("st-nav-collapsed", collapsed);
		this.renderNav();
		void this.plugin.saveSettings({ from: this, scope: "none" });
		window.requestAnimationFrame(() => this.queueLayout());
	}

	/** First line of the page's first description, without formatting markers. */
	private pageSnippet(page: Page): string {
		for (const panel of page.panels) {
			for (const b of panel.blocks) {
				const text = parseInline(b.text)
					.filter((x) => !x.marker)
					.map((x) => x.text)
					.join("")
					.replace(/\s+/g, " ")
					.trim();
				if (text) return text.slice(0, 120);
			}
		}
		return "";
	}

	/** Scrolls a page to the top of the script (smoothly unless motion is off) and marks it current. */
	private navTo(pageId: string) {
		const el = this.scriptEl?.querySelector<HTMLElement>(`.st-sheet [data-id="${pageId}"]`);
		if (!el) return;
		const target = this.readMode ? el.closest<HTMLElement>(".st-read-sheet") ?? el : el;
		const top = this.scriptEl.getBoundingClientRect().top;
		const offset = this.readMode && target !== el ? 12 : 24;
		const delta = target.getBoundingClientRect().top - top - offset;
		// Long jumps are instant (gliding past 20 pages is just slow); short hops glide.
		const far = Math.abs(delta) > this.scriptEl.clientHeight * 2;
		this.navLockUntil = Date.now() + (far || !this.motion ? 120 : 700);
		this.scriptEl.scrollTo({ top: this.scriptEl.scrollTop + delta, behavior: this.motion && !far ? "smooth" : "auto" });
		this.setNavActive(pageId);
		if (this.motion) playOnce(el, "st-flash");
	}

	private stepPage(dir: -1 | 1) {
		const pages = this.doc.pages;
		const i = pages.findIndex((p) => p.id === this.navActiveId);
		const next = pages[Math.max(0, Math.min(pages.length - 1, (i < 0 ? 0 : i) + dir))];
		if (next) this.navTo(next.id);
	}

	private queueNavSpy() {
		// While a jump is scrolling, keep the destination highlighted instead of every page passed.
		if (Date.now() < this.navLockUntil) return;
		if (this.navSpyQueued) return;
		this.navSpyQueued = true;
		window.requestAnimationFrame(() => {
			this.navSpyQueued = false;
			this.updateNavActive();
		});
	}

	private queueNavRefresh() {
		if (this.navRefreshTimer !== null) window.clearTimeout(this.navRefreshTimer);
		this.navRefreshTimer = window.setTimeout(() => {
			this.navRefreshTimer = null;
			// Don't rebuild under the user's fingers while they type in the go-to box.
			if (this.navEl && !this.navEl.contains(document.activeElement)) this.renderNav();
		}, 700);
	}

	/** Highlights the page at the top third of the script ("you are here"). */
	private updateNavActive() {
		if (!this.scriptEl || !this.navEl) return;
		const pages = Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet .st-page, .st-sheet .st-r-page"));
		if (!pages.length) return;
		const view = this.scriptEl.getBoundingClientRect();
		const line = view.top + view.height * 0.3;
		let current = pages[0].dataset.id!;
		for (const p of pages) {
			if (p.getBoundingClientRect().top <= line) current = p.dataset.id!;
			else break;
		}
		// At the very bottom, the last page is current even if it's short.
		if (this.scriptEl.scrollTop + this.scriptEl.clientHeight >= this.scriptEl.scrollHeight - 2) current = pages[pages.length - 1].dataset.id!;
		this.setNavActive(current);
	}

	private setNavActive(pageId: string) {
		if (!this.navEl || this.navActiveId === pageId) return;
		this.navActiveId = pageId;
		this.navEl.querySelectorAll(".st-nav-item.is-active").forEach((x) => x.removeClass("is-active"));
		const item = this.navEl.querySelector<HTMLElement>(`.st-nav-item[data-page="${pageId}"]`);
		if (!item) return;
		item.addClass("is-active");
		item.setAttr("aria-current", "page");
		item.scrollIntoView({ block: "nearest" });
	}

	toggleReadMode() {
		this.setReadMode(!this.readMode);
	}

	/**
	 * Switches between editing and reading, keeping the same part of the script on screen.
	 * `focusId` (from double-clicking a line while reading) opens that item for editing.
	 */
	setReadMode(on: boolean, focusId?: string) {
		if (this.readMode === on) return;
		const anchor = this.topVisibleItem();
		this.readMode = on;
		this.hideFormatBar();
		this.draftTarget = null;
		this.draftRange = null;
		this.editingNote = null;
		// A different layout: don't glide items between the two.
		this.shownItems = null;
		this.flipFrom = null;
		if (focusId) this.focusAfterRender = focusId;
		this.renderAll();
		const canvas = this.scriptEl.querySelector<HTMLElement>(".st-canvas");
		if (canvas && this.motion) playOnce(canvas, "st-mode-enter");
		if (focusId) this.jumpTo(focusId);
		else if (anchor) this.restoreAnchor(anchor);
		if (on) this.contentEl.focus({ preventScroll: true });
	}

	/** The first page/panel/block whose top is on screen, and how far down the view it sits. */
	private topVisibleItem(): { id: string; offset: number } | null {
		if (!this.scriptEl) return null;
		const top = this.scriptEl.getBoundingClientRect().top;
		for (const el of Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet [data-id]"))) {
			const r = el.getBoundingClientRect();
			if (r.top >= top - 2) return { id: el.dataset.id!, offset: r.top - top };
		}
		return null;
	}

	private restoreAnchor(anchor: { id: string; offset: number }) {
		const el = this.scriptEl.querySelector<HTMLElement>(`.st-sheet [data-id="${anchor.id}"]`);
		if (!el) return;
		const top = this.scriptEl.getBoundingClientRect().top;
		this.scriptEl.scrollTop += el.getBoundingClientRect().top - top - anchor.offset;
	}

	/**
	 * Read mode: the script as it will print, one sheet per comic page (like the .docx),
	 * formatting shown without its ** markers, empty blocks and all editing chrome left out.
	 */
	private renderRead() {
		const s = this.plugin.settings;
		const canvas = this.scriptEl.createDiv("st-canvas st-read");
		const balloons = balloonNumbers(this.doc, s, s.balloonScope);
		let sheet = canvas.createDiv("st-sheet st-read-sheet");
		sheet.createDiv({ cls: "st-r-p st-r-title", text: (this.doc.title || "Untitled").toUpperCase() });
		if (this.doc.byline.trim()) sheet.createDiv({ cls: "st-r-p", text: this.doc.byline.trim() });

		this.doc.pages.forEach((page, pi) => {
			if (pi > 0 && s.exportPageBreaks) sheet = canvas.createDiv("st-sheet st-read-sheet");
			const pageEl = sheet.createDiv({ cls: "st-r-page", attr: { "data-id": page.id } });
			pageEl.createDiv({ cls: "st-r-p st-b", text: pageLabel(pi, s.pageNumberStyle) });

			page.panels.forEach((panel, ni) => {
				const panelEl = pageEl.createDiv({ cls: "st-r-panel", attr: { "data-id": panel.id } });
				const blocks = [...panel.blocks];
				const first = blocks[0] && findType(s, blocks[0].typeId).style === "description" ? blocks.shift()! : null;
				const line = panelEl.createDiv({ cls: "st-r-p", attr: first ? { "data-id": first.id } : {} });
				line.createSpan({ cls: "st-b", text: panelLabel(ni) + "  " });
				if (first) this.readInline(line, first.text);

				for (const b of blocks) {
					const type = findType(s, b.typeId);
					if (type.style === "lettering") {
						const n = balloons.get(b.id);
						const speaker = (type.fixedSpeaker ? type.defaultSpeaker || type.name : b.speaker || type.defaultSpeaker || type.name).toUpperCase();
						const mod = b.modifier.trim() ? ` (${b.modifier.trim()})` : "";
						const row = panelEl.createDiv({ cls: "st-r-p st-r-dialogue", attr: { "data-id": b.id } });
						row.createDiv({ cls: "st-r-who", text: `${n !== undefined ? n + ". " : ""}${speaker}${mod}:` });
						this.readInline(row.createDiv("st-r-line"), b.text);
					} else if (type.style === "freestyle") {
						if (!b.text.trim()) continue;
						const p = panelEl.createDiv({ cls: "st-r-p", attr: { "data-id": b.id } });
						this.applyFreeClasses(p, freeFormat(b));
						this.readInline(p, b.text);
					} else if (b.text.trim()) {
						this.readInline(panelEl.createDiv({ cls: "st-r-p", attr: { "data-id": b.id } }), b.text);
					}
				}
			});
		});
		if (!this.doc.pages.length) sheet.createDiv({ cls: "st-r-p st-r-empty", text: "Nothing to read yet. Switch to Edit to start writing." });
		canvas.createDiv({ cls: "st-read-hint", text: "Double-click any line to edit it · Ctrl+E switches modes" });

		// Direct manipulation: double-click what you want to change.
		canvas.addEventListener("dblclick", (e) => {
			const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
			window.getSelection()?.removeAllRanges();
			this.setReadMode(false, el?.dataset.id);
		});
	}

	/** Formatted text with its markers dropped, as it appears in the export. */
	private readInline(parent: HTMLElement, text: string) {
		for (const seg of parseInline(text)) {
			if (seg.marker) continue;
			if (!seg.bold && !seg.italic && !seg.underline && !seg.highlight) {
				parent.appendText(seg.text);
				continue;
			}
			const span = parent.createSpan({ text: seg.text });
			if (seg.bold) span.addClass("st-b");
			if (seg.italic) span.addClass("st-i");
			if (seg.underline) span.addClass("st-u");
			if (seg.highlight) span.addClass("st-mark", "st-mark-" + seg.highlight);
		}
	}

	showHelp(tab: HelpTab = "start") {
		new HelpModal(this.app, tab).open();
	}

	private onKeydown(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		if (e.altKey && !mod && (e.key === "PageUp" || e.key === "PageDown")) {
			e.preventDefault();
			return this.stepPage(e.key === "PageUp" ? -1 : 1);
		}
		// "?" opens help, as in most apps, unless you're typing.
		const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
		if (e.key === "?" && !mod && !e.altKey && !typing) {
			e.preventDefault();
			return this.showHelp();
		}
		if (!mod) return;
		if (e.key === "/") {
			e.preventDefault();
			return this.showHelp("shortcuts");
		}
		if (e.key.toLowerCase() === "e" && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			return this.setReadMode(!this.readMode);
		}
		const target = e.target as HTMLElement;
		// Inside a field (block text included), Ctrl+Z belongs to the field.
		const inField = !!target.closest("input, textarea, [contenteditable='true']");
		const key = e.key.toLowerCase();
		if (!inField && key === "z") {
			e.preventDefault();
			e.shiftKey ? this.redo() : this.undo();
		} else if (!inField && key === "y") {
			e.preventDefault();
			this.redo();
		}
	}

	// ---------------------------------------------------------------- rendering

	renderAll() {
		const root = this.contentEl;
		const scrollTop = this.scriptEl?.scrollTop ?? 0;
		// Rebuilding removes the focused field; keep keyboard focus in this view so
		// shortcuts (Ctrl+Z, Ctrl+E, ?) keep working without an extra click.
		const hadFocus = root.contains(document.activeElement);
		this.destroyEditors();
		root.empty();
		this.panelCountEls.clear();
		this.marginEl = null;
		this.sheetObserver?.disconnect();
		this.applyAppearance();

		if (this.loadError !== null) {
			const err = root.createDiv("st-load-error");
			err.createEl("h3", { text: "This file isn't a valid comic script." });
			err.createEl("p", {
				text: "It couldn't be parsed as JSON, so it's been left untouched. Fix it in another editor or restore it from a backup.",
			});
			return;
		}

		const reading = this.readMode;
		root.toggleClass("is-reading", reading);
		this.renderToolbar(root.createDiv("st-toolbar"));
		const body = root.createDiv("st-body");
		body.toggleClass("st-no-palette", reading || !this.paletteOpen);
		body.toggleClass("st-no-side", reading || !this.sideOpen);
		body.setCssProps({ "--st-palette-w": this.plugin.settings.paletteWidth + "px" });
		body.toggleClass("st-nav-collapsed", this.plugin.settings.pageNavCollapsed);
		this.paletteEl = body.createDiv("st-palette");
		this.wirePaletteDrop(this.paletteEl);
		this.navEl = body.createDiv({ cls: "st-nav", attr: { role: "navigation", "aria-label": "Pages" } });
		if (this.paletteOpen && !reading) this.makeResizer(body);
		this.scriptEl = body.createDiv("st-script");
		this.wireScriptDrop(this.scriptEl);
		this.wireFieldKeys(this.scriptEl);
		this.scriptEl.addEventListener(
			"scroll",
			() => {
				this.hideFormatBar();
				this.queueNavSpy();
			},
			{ passive: true }
		);
		this.sideEl = body.createDiv("st-side");

		// Always-visible help, bottom-right, in both modes.
		const help = root.createEl("button", { cls: "st-help-fab", attr: { "aria-label": "Help, shortcuts and tips (?)", "data-tooltip-position": "left" } });
		setIcon(help, "help-circle");
		help.addEventListener("click", () => this.showHelp());

		this.datalistEl = root.createEl("datalist", { attr: { id: this.datalistId } });
		this.refreshSpeakers();

		if (reading) {
			this.renderRead();
		} else {
			this.renderPalette();
			this.renderScript();
			this.renderSide();
		}
		this.renderNav();
		this.scriptEl.scrollTop = scrollTop;
		this.updateStats();
		if (this.contentEl.isConnected && !reading) this.animateScript();

		window.requestAnimationFrame(() => {
			this.layoutMargin();
			if (this.focusAfterRender) {
				const sel = this.focusSelector ?? ".st-focus-first";
				const item = this.scriptEl.querySelector<HTMLElement>(`[data-id="${this.focusAfterRender}"]`);
				const el = item?.querySelector<HTMLElement>(sel) ?? item?.querySelector<HTMLElement>(".st-focus-first");
				if (el) this.focusEl(el, this.focusCaret);
				this.focusAfterRender = null;
				this.focusSelector = null;
				this.focusCaret = null;
			}
			if (hadFocus && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
			if (this.draftTarget) this.marginEl?.querySelector<HTMLTextAreaElement>(".st-comment-draft textarea")?.focus();
			else if (this.editingNote) this.marginEl?.querySelector<HTMLTextAreaElement>(".st-comment.is-editing textarea")?.focus();
		});
	}

	/** Redraws the script and side panel but leaves the palette alone (keeps focus in palette editors). */
	refreshScript() {
		if (this.loadError !== null || !this.scriptEl || this.readMode) return this.renderAll();
		const scrollTop = this.scriptEl.scrollTop;
		this.scriptEl.empty();
		this.sideEl.empty();
		this.panelCountEls.clear();
		this.marginEl = null;
		this.sheetObserver?.disconnect();
		this.destroyEditors();
		this.applyAppearance();
		this.refreshSpeakers();
		this.renderScript();
		this.renderSide();
		this.renderNav();
		this.updateStats();
		this.scriptEl.scrollTop = scrollTop;
		this.shownItems = new Set(Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet [data-id]"), (el) => el.dataset.id!));
		window.requestAnimationFrame(() => this.layoutMargin());
	}

	private applyAppearance() {
		const s = this.plugin.settings;
		this.contentEl.setCssProps({ "--st-font": s.fontFamily, "--st-font-size": s.fontSize + "px" });
		this.contentEl.removeClass("st-paper-auto", "st-paper-light", "st-paper-dark");
		this.contentEl.addClass("st-paper-" + s.paperMode);
	}

	private iconBtn(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "st-icon-btn clickable-icon " + cls, attr: { "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick(e);
		});
		return b;
	}

	/** "Export .docx" exports to the default folder; the arrow beside it lists every export folder. */
	private exportButton(bar: HTMLElement) {
		const group = bar.createDiv("st-export-group");
		const exp = group.createEl("button", { cls: "st-export-btn mod-cta", text: "Export .docx" });
		const arrow = group.createEl("button", { cls: "st-export-arrow mod-cta", attr: { "aria-label": "Choose export folder", "aria-haspopup": "menu" } });
		setIcon(arrow, "chevron-down");
		const describe = () => {
			const folder = this.plugin.exportFolders()[0] ?? "";
			exp.setAttr("aria-label", `Export to ${exportFolderLabel(folder)}`);
		};
		describe();
		exp.addEventListener("click", () => {
			void this.plugin.exportView(this, this.plugin.exportFolders()[0] ?? "").then(describe);
		});
		arrow.addEventListener("click", (e) => {
			e.stopPropagation();
			// The arrow toggles the menu. Obsidian closes an open menu on mousedown outside it, so a
			// menu that closed a moment ago was closed by this very click: leave it closed.
			if (this.exportMenu) return this.exportMenu.hide();
			if (Date.now() - this.exportMenuClosedAt < 300) return;
			const current = this.plugin.exportFolders()[0] ?? "";
			const folders = this.plugin.exportFolders(true);
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Export to…").setIsLabel(true));
			for (const folder of folders.length ? folders : [""]) {
				menu.addItem((i) =>
					i
						.setTitle(isSystemPath(folder) ? shortPath(folder) : exportFolderLabel(folder))
						.setIcon(!folder ? "file-symlink" : isSystemPath(folder) ? "hard-drive" : "folder")
						.setChecked(folder === current)
						.onClick(() => void this.plugin.exportView(this, folder).then(describe))
				);
			}
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle("Manage export folders…").setIcon("settings").onClick(() => {
					const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
					setting?.open();
					setting?.openTabById(this.plugin.manifest.id);
				})
			);
			const r = group.getBoundingClientRect();
			arrow.addClass("is-open");
			menu.onHide(() => {
				arrow.removeClass("is-open");
				this.exportMenu = null;
				this.exportMenuClosedAt = Date.now();
			});
			this.exportMenu = menu;
			// Anchored to the button's right edge so the menu opens under it, growing leftwards.
			menu.showAtPosition({ x: r.right, y: r.bottom + 4, left: true });
		});
	}

	private renderToolbar(bar: HTMLElement) {
		// The current mode is always visible, and one click away from the other.
		const modes = bar.createDiv({ cls: "st-mode-switch", attr: { role: "radiogroup", "aria-label": "Mode" } });
		const modeBtn = (read: boolean, icon: string, label: string) => {
			const b = modes.createEl("button", { cls: "st-mode-btn", attr: { role: "radio", "aria-checked": String(this.readMode === read), "aria-label": `${label} mode (Ctrl+E to switch)` } });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.toggleClass("is-active", this.readMode === read);
			b.addEventListener("click", () => this.setReadMode(read));
		};
		modeBtn(false, "pencil", "Edit");
		modeBtn(true, "book-open", "Read");
		bar.createDiv({ cls: "st-toolbar-sep" });

		if (this.readMode) {
			this.undoBtn = null;
			this.redoBtn = null;
		} else {
			this.iconBtn(bar, "layout-list", "Toggle block palette", () => {
				this.paletteOpen = !this.paletteOpen;
				this.renderAll();
			}, this.paletteOpen ? "is-active" : "");
			bar.createDiv({ cls: "st-toolbar-sep" });
			this.iconBtn(bar, "file-plus", "Add page", () => this.addPage());
			this.iconBtn(bar, "chevrons-down-up", "Collapse all pages", () => this.setAllCollapsed(true));
			this.iconBtn(bar, "chevrons-up-down", "Expand all", () => this.setAllCollapsed(false));
			bar.createDiv({ cls: "st-toolbar-sep" });
			this.undoBtn = this.iconBtn(bar, "undo-2", "Undo (Ctrl+Z)", () => this.undo());
			this.redoBtn = this.iconBtn(bar, "redo-2", "Redo (Ctrl+Shift+Z)", () => this.redo());
			this.updateHistoryButtons();
		}
		this.saveEl = bar.createDiv({ cls: "st-save-state" });
		this.setSaveState(this.saveState);
		this.statsEl = bar.createDiv("st-stats");

		const open = this.openNoteCount();
		const cb = this.readMode ? null : this.iconBtn(bar, "message-square", "Comments", (e) => {
			const menu = new Menu();
			menu.addItem((i) =>
				i.setTitle(this.marginOpen ? "Collapse comment margin" : "Expand comment margin").setIcon(this.marginOpen ? "chevrons-right" : "chevrons-left").onClick(() => {
					this.marginOpen = !this.marginOpen;
					this.renderAll();
				})
			);
			menu.addItem((i) =>
				i.setTitle("Show resolved comments").setChecked(this.showResolved).onClick(() => {
					this.showResolved = !this.showResolved;
					this.marginOpen = true;
					this.renderAll();
				})
			);
			menu.showAtMouseEvent(e);
		}, "st-comments-toggle" + (this.marginOpen && open ? " is-active" : ""));
		if (open && cb) cb.createSpan({ cls: "st-count", text: String(open) });

		this.paperToggle(bar);

		this.exportButton(bar);
		if (!this.readMode) {
			this.iconBtn(bar, "panel-right", "Pinned & revisions", () => {
				this.sideOpen = !this.sideOpen;
				this.renderAll();
			}, this.sideOpen ? "is-active" : "");
		}
	}

	/** Is the paper currently dark (explicitly, or via Auto + Obsidian's dark theme)? */
	private paperIsDark(): boolean {
		const mode = this.plugin.settings.paperMode;
		if (mode !== "auto") return mode === "dark";
		return this.contentEl.ownerDocument.body.hasClass("theme-dark");
	}

	/** Sun/moon button: click flips light/dark paper; right-click (or the menu) picks Auto/Light/Dark. */
	private paperToggle(bar: HTMLElement) {
		const dark = this.paperIsDark();
		const mode = this.plugin.settings.paperMode;
		const set = (m: PaperMode) => {
			this.plugin.settings.paperMode = m;
			this.applyAppearance(); // colours change in place, no re-render needed
			void this.plugin.saveSettings({ from: this, scope: "none" });
			this.updatePaperIcon();
		};
		const b = this.iconBtn(bar, dark ? "moon" : "sun", this.paperLabel(), () => set(this.paperIsDark() ? "light" : "dark"), "st-paper-toggle");
		b.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			const opts: [PaperMode, string, string][] = [
				["auto", "Auto (match Obsidian)", "monitor"],
				["light", "Light paper", "sun"],
				["dark", "Dark paper", "moon"],
			];
			for (const [m, label, icon] of opts) menu.addItem((i) => i.setTitle(label).setIcon(icon).setChecked(mode === m).onClick(() => set(m)));
			menu.showAtMouseEvent(e);
		});
	}

	private updatePaperIcon() {
		const btn = this.contentEl.querySelector<HTMLElement>(".st-paper-toggle");
		if (!btn) return;
		setIcon(btn, this.paperIsDark() ? "moon" : "sun");
		btn.setAttr("aria-label", this.paperLabel());
	}

	private paperLabel(): string {
		const m = this.plugin.settings.paperMode;
		const now = m === "auto" ? `Auto (${this.paperIsDark() ? "dark" : "light"})` : m === "dark" ? "Dark paper" : "Light paper";
		return `${now} · click to switch, right-click for Auto`;
	}

	private openNoteCount(): number {
		let n = 0;
		for (const ref of walk(this.doc)) n += ref.item.notes.filter((x) => !x.resolved).length;
		return n;
	}

	private updateStats() {
		this.queueNavRefresh();
		if (!this.statsEl) return;
		let panels = 0;
		let words = 0;
		let revisions = 0;
		for (const ref of walk(this.doc)) {
			if (ref.kind === "panel") panels++;
			if (ref.kind === "block") words += wordCount((ref.item as Block).text);
			if (ref.item.revision) revisions++;
		}
		const p = this.doc.pages.length;
		this.statsEl.setText(
			`${p} page${p === 1 ? "" : "s"} · ${panels} panel${panels === 1 ? "" : "s"} · ${words} words` +
				(revisions ? ` · ${revisions} to revise` : "")
		);
	}

	// ---------------------------------------------------------------- palette

	/** Rebuilds just the palette column (sections, chips or inline editors). */
	renderPalette() {
		const el = this.paletteEl;
		if (!el) return;
		const settings = this.plugin.settings;
		ensureSections(settings);
		const scroll = el.scrollTop;
		el.empty();
		this.paletteWide = settings.paletteWidth >= WIDE_PALETTE;
		el.toggleClass("is-wide", this.paletteWide);

		el.createDiv({ cls: "st-palette-heading", text: "Structure" });
		const structure = el.createDiv("st-pal-items");
		this.paletteChip(structure, "Page", "var(--text-normal)", { kind: "new-page" }, () => this.addPage(), "file");
		this.paletteChip(structure, "Panel", "var(--text-normal)", { kind: "new-panel" }, () => this.addPanelToActivePage(), "square");

		settings.paletteSections.forEach((sec, i) => this.renderPaletteSection(el, sec, i));

		const addSection = el.createEl("button", { cls: "st-palette-add st-plus", text: "New section" });
		addSection.addEventListener("click", () =>
			new PromptModal(this.app, "New palette section", "My blocks", (name) => {
				settings.paletteSections.push(newSection(name));
				this.savePalette("palette");
			}).open()
		);
		el.createDiv({
			cls: "st-palette-hint",
			text: this.paletteWide
				? "Edit blocks right here. Star a block to show it under each panel. Drag a card by its grip into the script or another section. Drag the palette's edge narrower for compact chips."
				: "Drag into the script, or click to add to the current panel. Star a block to show it under each panel. Drag blocks between sections to organise them. Drag the palette's edge wider to edit blocks in place.",
		});
		el.scrollTop = scroll;

		const items = Array.from(el.querySelectorAll<HTMLElement>("[data-pkey]"));
		this.shownPalette = animateRender(items, (e) => e.dataset.pkey, this.motion ? this.shownPalette : null, null);
	}

	private savePalette(scope: "all" | "script" | "palette" | "none") {
		if (this.quickAddSignature() !== this.quickAddDrawn) {
			if (scope === "palette") scope = "all";
			else if (scope === "none") scope = "script";
		}
		void this.plugin.saveSettings({ from: this, scope });
	}

	private quickAddSignature(): string {
		const s = this.plugin.settings;
		return JSON.stringify(starredItems(s).map((k) => [k, s.presets.find((p) => presetKey(p.id) === k)?.name, s.presets.find((p) => presetKey(p.id) === k)?.typeId]));
	}

	private renderPaletteSection(parent: HTMLElement, sec: PaletteSection, index: number) {
		const settings = this.plugin.settings;
		const wrap = parent.createDiv({ cls: "st-pal-section", attr: { "data-section": sec.id } });
		const head = wrap.createDiv("st-pal-head");

		this.iconBtn(head, sec.collapsed ? "chevron-right" : "chevron-down", sec.collapsed ? "Expand section" : "Collapse section", () => {
			sec.collapsed = !sec.collapsed;
			this.savePalette("palette");
		}, "st-pal-chevron");
		if (this.paletteWide) {
			const name = head.createEl("input", { cls: "st-pal-name", attr: { type: "text", "aria-label": "Section name" } });
			name.value = sec.name;
			name.addEventListener("change", () => {
				sec.name = name.value.trim() || sec.name;
				this.savePalette("none");
			});
		} else {
			const name = head.createSpan({ cls: "st-pal-title", text: sec.name });
			name.addEventListener("dblclick", () => this.renameSection(sec));
		}
		head.createSpan({ cls: "st-pal-count", text: String(sec.items.length) });
		const menu = (e: MouseEvent) => this.sectionMenu(e, sec, index);
		this.iconBtn(head, "more-horizontal", "Section options", menu, "st-pal-more");
		head.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			menu(e);
		});

		if (sec.collapsed) {
			return;
		}
		const list = wrap.createDiv("st-pal-items");
		for (const key of sec.items) {
			const sep = key.indexOf(":");
			const kind = key.slice(0, sep);
			const id = key.slice(sep + 1);
			if (kind === "type") {
				const type = settings.blockTypes.find((t) => t.id === id);
				if (type) this.paletteWide ? this.typeEditor(list, type, sec) : this.typeChip(list, type, sec);
			} else {
				const preset = settings.presets.find((p) => p.id === id);
				if (preset) this.paletteWide ? this.presetEditor(list, preset, sec) : this.presetChip(list, preset, sec);
			}
		}
		Array.from(list.children).forEach((el, i) => sec.items[i] && ((el as HTMLElement).dataset.pkey = sec.id + "/" + sec.items[i]));
		if (!sec.items.length) list.createDiv({ cls: "st-pal-empty", text: "Drag blocks here" });

		const add = wrap.createEl("button", { cls: "st-pal-add-type st-plus", text: "Block type" });
		add.addEventListener("click", () => this.newTypeIn(sec));
	}

	private renameSection(sec: PaletteSection) {
		new PromptModal(this.app, "Rename section", sec.name, (name) => {
			sec.name = name;
			this.savePalette("palette");
		}).open();
	}

	private newTypeIn(sec: PaletteSection) {
		new BlockTypeModal(this.app, null, (t) => {
			this.plugin.settings.blockTypes.push(t);
			sec.items.push(typeKey(t.id));
			this.savePalette("all");
		}).open();
	}

	private sectionMenu(e: MouseEvent, sec: PaletteSection, index: number) {
		const list = this.plugin.settings.paletteSections;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Rename section").setIcon("pencil").onClick(() => this.renameSection(sec)));
		menu.addItem((i) => i.setTitle("New block type here").setIcon("plus").onClick(() => this.newTypeIn(sec)));
		menu.addItem((i) =>
			i.setTitle("New section below").setIcon("folder-plus").onClick(() =>
				new PromptModal(this.app, "New palette section", "My blocks", (name) => {
					list.splice(index + 1, 0, newSection(name));
					this.savePalette("palette");
				}).open()
			)
		);
		if (index > 0) {
			menu.addItem((i) =>
				i.setTitle("Move section up").setIcon("arrow-up").onClick(() => {
					list.splice(index - 1, 0, list.splice(index, 1)[0]);
					this.savePalette("palette");
				})
			);
		}
		if (index < list.length - 1) {
			menu.addItem((i) =>
				i.setTitle("Move section down").setIcon("arrow-down").onClick(() => {
					list.splice(index + 1, 0, list.splice(index, 1)[0]);
					this.savePalette("palette");
				})
			);
		}
		if (list.length > 1) {
			menu.addSeparator();
			menu.addItem((i) => {
				i.setTitle("Delete section").setIcon("trash").onClick(() => {
					const other = list[index === 0 ? 1 : 0];
					const remove = () => {
						other.items.push(...sec.items);
						list.splice(list.indexOf(sec), 1);
						this.savePalette("palette");
					};
					if (!sec.items.length) return remove();
					const n = sec.items.length;
					new ConfirmModal(
						this.app,
						`Delete “${sec.name}”?`,
						`Its ${n} block${n === 1 ? "" : "s"} will move to “${other.name}”. Nothing is removed from your scripts.`,
						"Delete section",
						remove
					).open();
				});
				i.setWarning(true);
			});
		}
		menu.showAtMouseEvent(e);
	}

	/** "Move to section ▸" entries shared by every palette item menu. */
	private moveToSectionItems(menu: Menu, key: string, current: PaletteSection) {
		const others = this.plugin.settings.paletteSections.filter((s) => s !== current);
		if (!others.length) return;
		this.submenu(menu, "Move to section", "folder-input", (m) => {
			for (const sec of others) {
				m.addItem((i) =>
					i.setTitle(sec.name).onClick(() => {
						moveToSection(this.plugin.settings, key, sec, sec.items.length);
						this.savePalette("palette");
					})
				);
			}
		});
	}

	private deleteType(type: BlockType) {
		const used = [...walk(this.doc)].filter((r) => r.kind === "block" && (r.item as Block).typeId === type.id).length;
		new ConfirmModal(
			this.app,
			`Delete block type “${type.name}”?`,
			used
				? `${used} block${used === 1 ? "" : "s"} in this script use it. They keep their text but show as plain descriptions until you change their type.`
				: "It isn't used in this script. Blocks in other scripts that use it keep their text.",
			"Delete",
			() => {
				const s = this.plugin.settings;
				s.blockTypes.remove(type);
				s.newPanelBlocks = s.newPanelBlocks.filter((id) => id !== type.id);
				this.savePalette("all");
			}
		).open();
	}

	private typeChip(list: HTMLElement, type: BlockType, sec: PaletteSection) {
		const chip = this.paletteChip(list, type.name, type.color, { kind: "new-block", typeId: type.id }, () => this.addBlockToActivePanel(newBlock(type)));
		this.starToggle(chip, typeKey(type.id));
		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			this.starMenuItem(menu, typeKey(type.id));
			menu.addItem((i) =>
				i.setTitle("Edit block type").setIcon("pencil").onClick(() =>
					new BlockTypeModal(this.app, type, (t) => {
						Object.assign(type, t);
						this.savePalette("all");
					}).open()
				)
			);
			this.moveToSectionItems(menu, typeKey(type.id), sec);
			menu.addSeparator();
			menu.addItem((i) => {
				i.setTitle("Delete block type").setIcon("trash").onClick(() => this.deleteType(type));
				i.setWarning(true);
			});
			menu.showAtMouseEvent(e);
		});
	}

	private presetChip(list: HTMLElement, preset: BlockPreset, sec: PaletteSection) {
		const settings = this.plugin.settings;
		const type = findType(settings, preset.typeId);
		const chip = this.paletteChip(list, preset.name, type.color, { kind: "preset", presetId: preset.id }, () => this.addBlockToActivePanel(blockFromPreset(preset)));
		chip.addClass("is-preset");
		chip.setAttr("title", preset.speaker ? `${preset.speaker}: ${preset.text}` : preset.text);
		this.starToggle(chip, presetKey(preset.id));
		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			this.starMenuItem(menu, presetKey(preset.id));
			menu.addItem((i) =>
				i.setTitle("Rename").setIcon("pencil").onClick(() =>
					new PromptModal(this.app, "Rename saved block", preset.name, (v) => {
						preset.name = v;
						this.savePalette("palette");
					}).open()
				)
			);
			this.moveToSectionItems(menu, presetKey(preset.id), sec);
			menu.addSeparator();
			menu.addItem((i) => {
				i.setTitle("Delete saved block").setIcon("trash").onClick(() => {
					settings.presets.remove(preset);
					this.savePalette("palette");
				});
				i.setWarning(true);
			});
			menu.showAtMouseEvent(e);
		});
	}

	/** Wide palette: a block type as an inline editor card. */
	private typeEditor(list: HTMLElement, type: BlockType, sec: PaletteSection) {
		const card = this.paletteCard(list, type.color, { kind: "new-block", typeId: type.id });
		const top = card.createDiv("st-pal-row");
		this.cardGrip(top, card);
		const color = top.createEl("input", { cls: "st-pal-color", attr: { type: "color", "aria-label": "Colour" } });
		color.value = type.color;
		color.addEventListener("input", () => card.setCssProps({ "--st-type-color": color.value }));
		color.addEventListener("change", () => {
			type.color = color.value;
			this.savePalette("script");
		});
		const name = top.createEl("input", { cls: "st-pal-input st-pal-type-name", attr: { type: "text", "aria-label": "Block name" } });
		name.value = type.name;
		name.addEventListener("change", () => {
			type.name = name.value.trim() || type.name;
			this.savePalette("script");
		});
		this.starToggle(top, typeKey(type.id));
		this.iconBtn(top, "plus", "Add to current panel", () => this.addBlockToActivePanel(newBlock(type)));
		this.iconBtn(top, "more-horizontal", "More", (e) => {
			const menu = new Menu();
			this.moveToSectionItems(menu, typeKey(type.id), sec);
			menu.addItem((i) => {
				i.setTitle("Delete block type").setIcon("trash").onClick(() => this.deleteType(type));
				i.setWarning(true);
			});
			menu.showAtMouseEvent(e);
		});

		const row = card.createDiv("st-pal-row");
		const layout = row.createEl("select", { cls: "dropdown st-pal-select", attr: { "aria-label": "Layout" } });
		layout.createEl("option", { text: "Description", attr: { value: "description" } });
		layout.createEl("option", { text: "Lettering", attr: { value: "lettering" } });
		layout.createEl("option", { text: "Freestyle", attr: { value: "freestyle" } });
		layout.value = type.style;
		layout.addEventListener("change", () => {
			type.style = layout.value as BlockType["style"];
			this.savePalette("all");
		});
		if (type.style === "lettering") {
			this.cardCheck(row, "Numbered", type.numbered, (v) => {
				type.numbered = v;
				this.savePalette("script");
			});
			const sp = card.createDiv("st-pal-row");
			const speaker = sp.createEl("input", { cls: "st-pal-input", attr: { type: "text", placeholder: "Default speaker", "aria-label": "Default speaker" } });
			speaker.value = type.defaultSpeaker;
			speaker.addEventListener("change", () => {
				type.defaultSpeaker = speaker.value.trim().toUpperCase();
				speaker.value = type.defaultSpeaker;
				this.savePalette("script");
			});
			this.cardCheck(sp, "Fixed", type.fixedSpeaker, (v) => {
				type.fixedSpeaker = v;
				this.savePalette("script");
			});
		}
		const text = card.createEl("textarea", { cls: "st-pal-input st-pal-text", attr: { rows: "1", placeholder: "Default text (optional)", "aria-label": "Default text" } });
		text.value = type.defaultText;
		text.addEventListener("change", () => {
			type.defaultText = text.value;
			this.savePalette("none");
		});
	}

	/** Wide palette: a saved block as an inline editor card. */
	private presetEditor(list: HTMLElement, preset: BlockPreset, sec: PaletteSection) {
		const settings = this.plugin.settings;
		const type = findType(settings, preset.typeId);
		const card = this.paletteCard(list, type.color, { kind: "preset", presetId: preset.id });
		card.addClass("is-preset");
		const top = card.createDiv("st-pal-row");
		this.cardGrip(top, card);
		const name = top.createEl("input", { cls: "st-pal-input st-pal-type-name", attr: { type: "text", "aria-label": "Saved block name" } });
		name.value = preset.name;
		name.addEventListener("change", () => {
			preset.name = name.value.trim() || preset.name;
			this.savePalette("none");
		});
		this.starToggle(top, presetKey(preset.id));
		this.iconBtn(top, "plus", "Add to current panel", () => this.addBlockToActivePanel(blockFromPreset(preset)));
		this.iconBtn(top, "more-horizontal", "More", (e) => {
			const menu = new Menu();
			this.moveToSectionItems(menu, presetKey(preset.id), sec);
			menu.addItem((i) => {
				i.setTitle("Delete saved block").setIcon("trash").onClick(() => {
					settings.presets.remove(preset);
					this.savePalette("palette");
				});
				i.setWarning(true);
			});
			menu.showAtMouseEvent(e);
		});

		const row = card.createDiv("st-pal-row");
		const typeSel = row.createEl("select", { cls: "dropdown st-pal-select", attr: { "aria-label": "Block type" } });
		for (const t of settings.blockTypes) typeSel.createEl("option", { text: t.name, attr: { value: t.id } });
		typeSel.value = preset.typeId;
		typeSel.addEventListener("change", () => {
			preset.typeId = typeSel.value;
			this.savePalette("palette");
		});
		if (type.style === "lettering" && !type.fixedSpeaker) {
			const sp = row.createEl("input", { cls: "st-pal-input", attr: { type: "text", placeholder: "Speaker (mod)", "aria-label": "Speaker" } });
			sp.value = preset.speaker + (preset.modifier ? ` (${preset.modifier})` : "");
			sp.addEventListener("change", () => {
				const v = sp.value;
				const i = v.indexOf("(");
				preset.speaker = (i < 0 ? v : v.slice(0, i)).trim().toUpperCase();
				preset.modifier = i < 0 ? "" : v.slice(i + 1).replace(/\)\s*$/, "").trim();
				this.savePalette("none");
			});
		}
		const text = card.createEl("textarea", { cls: "st-pal-input st-pal-text", attr: { rows: "2", placeholder: "Text", "aria-label": "Text" } });
		text.value = preset.text;
		text.addEventListener("change", () => {
			preset.text = text.value;
			this.savePalette("none");
		});
	}

	/** Star button: starred palette items get a button in each panel's quick-add row. */
	private starToggle(parent: HTMLElement, key: string) {
		const on = isStarred(this.plugin.settings, key);
		const b = parent.createEl("button", {
			cls: "st-star clickable-icon" + (on ? " is-starred" : ""),
			attr: { "aria-label": on ? "Starred: shown under each panel (click to remove)" : "Star to show under each panel", "aria-pressed": String(on), draggable: "false" },
		});
		setIcon(b, "star");
		b.addEventListener("mousedown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			toggleStar(this.plugin.settings, key);
			this.savePalette("all");
		});
	}

	private starMenuItem(menu: Menu, key: string) {
		const on = isStarred(this.plugin.settings, key);
		menu.addItem((i) =>
			i.setTitle(on ? "Unstar (hide under panels)" : "Star (show under panels)").setIcon("star").onClick(() => {
				toggleStar(this.plugin.settings, key);
				this.savePalette("all");
			})
		);
	}

	private paletteCard(list: HTMLElement, color: string, payload: DragPayload): HTMLElement {
		const card = list.createDiv({ cls: "st-pal-card", attr: { "data-drag-item": "" } });
		card.setCssProps({ "--st-type-color": color });
		card.addEventListener("dragstart", (e) => {
			if (e.target === card) this.startDrag(e, payload, card);
		});
		return card;
	}

	/** Cards are only draggable while the grip is held, so their inputs stay editable. */
	private cardGrip(row: HTMLElement, card: HTMLElement) {
		const grip = row.createSpan({ cls: "st-pal-grip", attr: { "aria-label": "Drag into the script or another section" } });
		setIcon(grip, "grip-vertical");
		grip.addEventListener("mousedown", () => card.setAttr("draggable", "true"));
		grip.addEventListener("mouseup", () => card.removeAttribute("draggable"));
	}

	private cardCheck(row: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void) {
		const wrap = row.createEl("label", { cls: "st-pal-check" });
		const cb = wrap.createEl("input", { attr: { type: "checkbox" } });
		cb.checked = value;
		wrap.appendText(" " + label);
		cb.addEventListener("change", () => onChange(cb.checked));
	}

	private paletteChip(parent: HTMLElement, label: string, color: string, payload: DragPayload, onClick: () => void, icon?: string): HTMLElement {
		const chip = parent.createDiv({
			cls: "st-chip",
			attr: { draggable: "true", "data-drag-item": "", tabindex: "0", role: "button", "aria-label": `Add ${label} (or drag into the script)` },
		});
		chip.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onClick();
			}
		});
		chip.setCssProps({ "--st-type-color": color });
		if (icon) setIcon(chip.createSpan("st-chip-icon"), icon);
		else chip.createSpan("st-chip-dot");
		chip.createSpan({ cls: "st-chip-label", text: label });
		chip.addEventListener("click", onClick);
		chip.addEventListener("dragstart", (e) => this.startDrag(e, payload, chip));
		return chip;
	}

	/**
	 * Sections accept block types and saved blocks (to reorder or move them), and blocks
	 * dragged out of the script, which become new saved blocks.
	 */
	private performPaletteDrop(sec: PaletteSection, at: number, payload: DragPayload) {
		const settings = this.plugin.settings;
		if (payload.kind === "new-block") moveToSection(settings, typeKey(payload.typeId), sec, at);
		else if (payload.kind === "preset") moveToSection(settings, presetKey(payload.presetId), sec, at);
		else if (payload.kind === "block") {
			const ref = findRef(this.doc, payload.id);
			if (!ref?.block) return;
			const b = ref.block;
			const type = findType(settings, b.typeId);
			const preset: BlockPreset = {
				id: uid(),
				name: ((b.speaker || type.name) + ": " + b.text).slice(0, 32),
				typeId: b.typeId,
				speaker: b.speaker,
				modifier: b.modifier,
				text: b.text,
			};
			settings.presets.push(preset);
			sec.items.splice(at, 0, presetKey(preset.id));
			new Notice(`Saved “${preset.name}” to ${sec.name}.`);
		} else return;
		if (sec.collapsed) sec.collapsed = false;
		this.savePalette("palette");
	}

	/** Drag-resizes the palette; crossing WIDE_PALETTE swaps chips for inline editors. */
	private makeResizer(body: HTMLElement) {
		const handle = body.createDiv({ cls: "st-palette-resizer", attr: { "aria-label": "Drag to resize · double-click to switch between chips and editors" } });
		const settings = this.plugin.settings;
		const apply = (w: number) => {
			settings.paletteWidth = Math.round(Math.max(MIN_PALETTE, Math.min(MAX_PALETTE, w)));
			body.setCssProps({ "--st-palette-w": settings.paletteWidth + "px" });
			if (settings.paletteWidth >= WIDE_PALETTE !== this.paletteWide) this.renderPalette();
		};
		handle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = settings.paletteWidth;
			body.addClass("is-resizing");
			const doc = handle.ownerDocument;
			const move = (ev: MouseEvent) => apply(startW + ev.clientX - startX);
			const up = () => {
				doc.removeEventListener("mousemove", move);
				doc.removeEventListener("mouseup", up);
				body.removeClass("is-resizing");
				this.savePalette("none");
			};
			doc.addEventListener("mousemove", move);
			doc.addEventListener("mouseup", up);
		});
		handle.addEventListener("dblclick", () => {
			apply(this.paletteWide ? 200 : 340);
			this.savePalette("none");
		});
	}

	// ---------------------------------------------------------------- script

	private renderScript() {
		this.quickAddDrawn = this.quickAddSignature();
		const canvas = this.scriptEl.createDiv("st-canvas");
		const paper = canvas.createDiv("st-sheet");

		const title = paper.createEl("input", { cls: "st-title", attr: { type: "text", placeholder: "Title of book #1", spellcheck: "false" } });
		title.value = this.doc.title;
		this.bindText(title, (v) => (this.doc.title = v));
		const byline = paper.createEl("input", { cls: "st-byline", attr: { type: "text", placeholder: "Date - by Your Name - you@email.com" } });
		byline.value = this.doc.byline;
		this.bindText(byline, (v) => (this.doc.byline = v));

		const pagesEl = paper.createDiv("st-pages");

		const balloons = balloonNumbers(this.doc, this.plugin.settings, this.plugin.settings.balloonScope);
		this.doc.pages.forEach((page, pi) => this.renderPage(pagesEl, page, pi, balloons));

		const add = paper.createEl("button", { cls: "st-add-btn st-plus", text: "Add page" });
		add.addEventListener("click", () => this.addPage());

		this.renderMargin(canvas);
		this.sheetObserver = new ResizeObserver(() => this.queueLayout());
		this.sheetObserver.observe(paper);
	}

	private renderPage(parent: HTMLElement, page: Page, pi: number, balloons: Map<string, number>) {
		const ref: ItemRef = { kind: "page", item: page, page, pageIndex: pi };
		const locked = isLocked(ref);
		const el = this.itemShell(parent, "page", ref);

		const head = el.createDiv("st-line st-page-head");
		const gutter = head.createDiv("st-gutter");
		this.dragHandle(gutter, el, ref, locked);
		const label = head.createSpan({ cls: "st-label", text: pageLabel(pi, this.plugin.settings.pageNumberStyle) });
		this.collapseToggle(gutter, label, page);
		const n = page.panels.length;
		head.createSpan({ cls: "st-meta", text: `${n} panel${n === 1 ? "" : "s"}` });
		this.badges(head, ref);
		const more = this.iconBtn(head, "more-horizontal", "Page options", (e) => this.itemMenu(e, ref), "st-page-more");
		more.addClass("st-hover-only");

		if (page.collapsed) {
			el.addClass("is-collapsed");
			return;
		}
		const panelsEl = el.createDiv("st-panels");

		page.panels.forEach((panel, ni) => this.renderPanel(panelsEl, page, pi, panel, ni, balloons));
		if (!locked) {
			const add = el.createEl("button", { cls: "st-add-btn st-add-panel st-plus", text: "Panel" });
			add.addEventListener("click", () => this.mutate(() => page.panels.push(newPanel(this.plugin.settings))));
		}
	}

	private renderPanel(parent: HTMLElement, page: Page, pi: number, panel: Panel, ni: number, balloons: Map<string, number>) {
		const ref: ItemRef = { kind: "panel", item: panel, page, panel, pageIndex: pi, panelIndex: ni };
		const locked = isLocked(ref);
		const el = this.itemShell(parent, "panel", ref);
		el.addEventListener("focusin", () => (this.activePanelId = panel.id));

		const gutter = el.createDiv("st-gutter st-panel-gutter");
		this.dragHandle(gutter, el, ref, locked);
		const label = createSpan({ cls: "st-label", text: panelLabel(ni) });
		this.collapseToggle(gutter, label, panel);
		this.badges(el.createDiv("st-side-badges st-panel-badges"), ref);
		const count = createSpan({ cls: "st-meta st-panel-count" });
		this.panelCountEls.set(panel.id, count);

		// As in the template, the first description runs on after "Panel N:".
		const first = panel.blocks[0];
		const inline = !panel.collapsed && !!first && findType(this.plugin.settings, first.typeId).style === "description";
		if (!inline) {
			const line = el.createDiv("st-line st-panel-line");
			line.append(label, count);
			if (panel.collapsed) {
				el.addClass("is-collapsed");
				const preview = panel.blocks.find((b) => b.text.trim());
				if (preview) line.createSpan({ cls: "st-collapsed-preview", text: preview.text.slice(0, 140) });
				this.updatePanelCount(panel);
				return;
			}
		}
		this.updatePanelCount(panel);

		const blocksEl = el.createDiv("st-blocks");

		panel.blocks.forEach((block, bi) =>
			this.renderBlock(
				blocksEl,
				{ kind: "block", item: block, page, panel, block, pageIndex: pi, panelIndex: ni, blockIndex: bi },
				balloons,
				bi === 0 && inline ? label : null
			)
		);

		const quick = el.createDiv("st-quick-add");
		if (inline) quick.appendChild(count);
		if (!locked) {
			const settings = this.plugin.settings;
			for (const key of starredItems(settings)) {
				const id = key.slice(key.indexOf(":") + 1);
				const preset = key.startsWith("preset:") ? settings.presets.find((p) => p.id === id) : undefined;
				const type = preset ? findType(settings, preset.typeId) : settings.blockTypes.find((t) => t.id === id);
				if (!type) continue;
				const b = quick.createEl("button", { text: "+ " + (preset ? preset.name : type.name) });
				b.setCssProps({ "--st-type-color": type.color });
				b.addEventListener("click", () => {
					const block = preset ? blockFromPreset(preset) : newBlock(type);
					this.focusAfterRender = block.id;
					this.mutate(() => panel.blocks.push(block));
				});
			}
		}
	}

	private renderBlock(parent: HTMLElement, ref: ItemRef, balloons: Map<string, number>, panelLabelEl: HTMLElement | null) {
		const block = ref.block!;
		const panel = ref.panel!;
		const type = findType(this.plugin.settings, block.typeId);
		const locked = isLocked(ref);
		const el = this.itemShell(parent, "block", ref);
		el.addClass("st-style-" + type.style);
		el.setCssProps({ "--st-type-color": type.color });
		el.setAttr("aria-label", type.name);
		el.setAttr("data-tooltip-position", "left");

		const gutter = el.createDiv("st-gutter st-block-gutter");
		// A description carrying "Panel N:" is the panel's heading line: only the panel's grip
		// belongs there, or grabbing the nearer one moves the text and leaves the label behind.
		if (!panelLabelEl) this.dragHandle(gutter, el, ref, locked);
		const side = el.createDiv("st-side-badges");
		this.badges(side, ref);

		const line = el.createDiv("st-block-line");
		let textCls = "st-text st-focus-first";
		let textPlaceholder = "";
		let firstIndent = "";

		if (type.style === "lettering") {
			const label = line.createDiv("st-lettering-label");
			const n = balloons.get(block.id);
			if (n !== undefined) label.createSpan({ cls: "st-balloon-num", text: n + ". " });
			if (type.fixedSpeaker) {
				// Speaker is fixed; only the "(modifier)" part is editable, e.g. "SFX (BIG)".
				const fixed = (type.defaultSpeaker || type.name).toUpperCase();
				const show = () => fixed + (block.modifier ? ` (${block.modifier})` : "");
				const sp = this.sizedInput(label, "st-speaker", fixed);
				sp.value = show();
				sp.readOnly = locked;
				sp.setAttr("aria-label", `Add a modifier in brackets, e.g. ${fixed} (BIG)`);
				this.bindText(sp, (v) => {
					const i = v.indexOf("(");
					block.modifier = i < 0 ? "" : v.slice(i + 1).replace(/\)\s*$/, "").trim();
				});
				sp.addEventListener("blur", () => {
					sp.value = show();
					this.fitInput(sp);
				});
			} else {
				const sp = this.sizedInput(label, "st-speaker st-focus-first", "CHARACTER");
				sp.setAttr("list", this.datalistId);
				sp.value = this.speakerText(block);
				sp.readOnly = locked;
				sp.setAttr("aria-label", "Speaker, with an optional modifier: MAYA (off)");
				this.bindText(sp, (v) => this.parseSpeaker(block, v));
				sp.addEventListener("blur", () => {
					const upper = block.speaker.toUpperCase();
					if (upper !== block.speaker) {
						block.speaker = upper;
						this.requestSave();
					}
					sp.value = this.speakerText(block);
					this.fitInput(sp);
					this.refreshSpeakers();
				});
			}
			label.createSpan({ cls: "st-colon", text: ":" });
			textCls = "st-text" + (type.fixedSpeaker ? " st-focus-first" : "");
			textPlaceholder = type.name + "…";
		} else if (type.style === "freestyle") {
			const f = freeFormat(block);
			this.applyFreeClasses(line, f);
			textPlaceholder = "Freestyle: anything goes (title cards, notes, lists…)";
			if (!locked) this.freeToolbar(el, block, f);
		} else {
			if (panelLabelEl) {
				line.appendChild(panelLabelEl);
				line.addClass("has-panel-label");
			}
			textPlaceholder = "Describe the panel…";
			// The label sits over the first line; indent the text past it so wrapped lines return to the margin.
			if (panelLabelEl) firstIndent = panelLabel(ref.panelIndex!).length + 2 + "ch";
		}

		if (firstIndent) line.setCssProps({ "--st-first-indent": firstIndent });
		// The block's text is drawn as formatted text; the editor itself is made when the pointer or
		// the keyboard gets there. A long script has hundreds of blocks, and making an editor for each
		// on every redraw took seconds.
		const host = line.createDiv({ cls: textCls + " st-text-static", attr: { tabindex: "0", role: "textbox", "aria-multiline": "true", "aria-label": textPlaceholder } });
		host.dataset.placeholder = textPlaceholder;
		this.staticBlocks.set(host, block);
		this.paintStatic(host);
		this.mounters.set(host, () => {
			const editor: RichEditor = new RichEditor({
				cls: textCls,
				text: block.text,
				placeholder: textPlaceholder,
				readOnly: locked,
				clipboardType: CLIP_MIME,
				ignoreDragTypes: [DRAG_MIME],
				comments: () => this.commentSpans(block),
				onChange: (text, changes) => {
					this.beginEdit();
					// Word comments stay on their words: typing at either edge stays outside them.
					// (Positions are clamped first: a file edited elsewhere could hold stale ones.)
					const map = (r: NoteRange): NoteRange => {
						const start = changes.mapPos(Math.min(r.start, changes.length), 1);
						return { start, end: Math.max(start, changes.mapPos(Math.min(r.end, changes.length), -1)) };
					};
					for (const n of block.notes) if (n.range) n.range = map(n.range);
					if (this.draftRange && this.draftTarget === block.id) this.draftRange = map(this.draftRange);
					block.text = text;
					this.updatePanelCount(panel);
					this.requestSave();
					this.updateStats();
					if (block.notes.some((n) => n.range)) this.refreshCardAnchors(block);
					this.queueLayout();
				},
				onSelection: () => {
					this.updateFormatBar(editor);
					this.activateNoteAtCaret(editor);
				},
				onFocus: () => (this.pendingSnapshot = JSON.stringify(this.doc)),
				onBlur: () =>
					window.setTimeout(() => {
						if (this.formatTarget === editor && !editor.hasFocus) this.hideFormatBar();
					}, 0),
				onKeydown: (e): boolean => this.editorKeys(e, editor, ref, type),
			});
			host.replaceWith(editor.dom);
			this.editors.add(editor);
			this.editorOf.set(editor.dom, editor);
			this.editorBlocks.set(editor, block);
			this.editorRefs.set(editor, { ref, type });
			return editor;
		});
		host.addEventListener("mouseenter", () => this.mountText(host));
		host.addEventListener("mousemove", () => this.mountText(host), { once: true });
		host.addEventListener("focus", () => this.mountText(host)?.focus());
		// Without a hover first (touch, or redrawn under a still pointer): put the cursor where it was pressed.
		host.addEventListener("mousedown", (e) => {
			const editor = this.mountText(host);
			if (!editor) return;
			e.preventDefault();
			editor.focusAt(e.clientX, e.clientY);
		});
	}

	/** Turns a block's drawn text into its editor (once), or returns the editor it already is. */
	private mountText(el: HTMLElement): RichEditor | null {
		const existing = this.editorOf.get(el);
		if (existing) return existing;
		const mount = this.mounters.get(el);
		if (!mount) return null;
		this.mounters.delete(el);
		return mount();
	}

	/** Draws a block's text as it reads: styled, markers hidden, commented words marked. */
	private paintStatic(host: HTMLElement) {
		const block = this.staticBlocks.get(host);
		if (!block) return;
		host.empty();
		const text = block.text;
		if (!text) {
			host.createSpan({ cls: "st-placeholder", text: host.dataset.placeholder ?? "" });
			return;
		}
		const comments = this.commentSpans(block);
		for (const { seg, from, to } of cutSegments(text, comments)) {
			if (seg.marker) continue;
			const on = comments.filter((c) => c.start < c.end && c.start <= from && c.end >= to);
			const cls = [seg.bold && "st-b", seg.italic && "st-i", seg.underline && "st-u", seg.highlight && `st-mark st-mark-${seg.highlight}`, on.length && "st-cmt", on.some((c) => c.active) && "is-active"].filter(Boolean);
			if (cls.length) host.createSpan({ cls: cls.join(" "), text: seg.text });
			else host.appendText(seg.text);
		}
		// A last empty line needs something on it to take up its height, as in the editor.
		if (text.endsWith("\n")) host.appendText("\u200b");
	}

	/** Screen box of a raw offset in drawn (not yet editable) text. */
	private staticCoords(host: HTMLElement, raw: number): DOMRect | null {
		const block = this.staticBlocks.get(host);
		if (!block) return null;
		const plain = rawToPlain(toRich(block.text), raw);
		const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		let last: Node | null = null;
		let seen = 0;
		while ((node = walker.nextNode())) {
			const len = node.textContent?.length ?? 0;
			if (plain < seen + len) {
				const range = document.createRange();
				range.setStart(node, plain - seen);
				range.setEnd(node, plain - seen + 1);
				return range.getClientRects()[0] ?? range.getBoundingClientRect();
			}
			seen += len;
			last = node;
		}
		// Past the last character: the end of the text.
		if (!last) return null;
		const range = document.createRange();
		range.selectNodeContents(last);
		const rects = range.getClientRects();
		return rects[rects.length - 1] ?? null;
	}

	/** A VIEW_KEYS key: goes to the block being edited (or switches modes); returns false when handled. */
	private viewKey(evt: KeyboardEvent): boolean {
		if (!this.contentEl.contains(document.activeElement)) return true;
		const ed = this.focusedEditor();
		const ctx = ed && this.editorRefs.get(ed);
		if (ed && ctx && this.editorKeys(evt, ed, ctx.ref, ctx.type)) return false;
		if (evt.key.toLowerCase() === "e" && !evt.shiftKey && !evt.altKey) {
			this.setReadMode(!this.readMode);
			return false;
		}
		return true;
	}

	/**
	 * Keys inside a block's text: formatting shortcuts, new blocks, comments, and moving between
	 * fields (↑/↓ at the start/end, Alt+↑/↓ moves the block, Esc leaves so Ctrl+Z undoes structure).
	 */
	private editorKeys(e: KeyboardEvent, editor: RichEditor, ref: ItemRef, type: BlockType): boolean {
		const mod = e.ctrlKey || e.metaKey;
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
			return true;
		};
		if (mod && e.key === "Enter") {
			if (isLocked(ref)) return false;
			e.shiftKey ? this.insertPanelAfter(ref) : this.insertBlockAfter(ref, type.id);
			return handled();
		}
		if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
			this.toggleQuickHighlight(editor);
			return handled();
		}
		// Ctrl+Alt+M, as in Word: comment on the selected words.
		if (mod && e.altKey && !e.shiftKey && e.code === "KeyM") {
			this.commentOnSelection(editor);
			return handled();
		}
		const key = this.shortcutStyle(e);
		if (key) {
			this.applyFormat(editor, key);
			return handled();
		}
		if (e.key === "Escape") {
			this.hideFormatBar();
			this.contentEl.focus({ preventScroll: true });
			return handled();
		}
		if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			this.moveBlockBy(ref.item.id, e.key === "ArrowUp" ? -1 : 1, ".st-text", editor.selection.from);
			return handled();
		}
		if (mod || e.altKey || e.shiftKey) return false;
		if (e.key === "ArrowDown" && editor.caretAtEnd() && this.focusField(editor.dom, 1)) return handled();
		if (e.key === "ArrowUp" && editor.caretAtStart() && this.focusField(editor.dom, -1)) return handled();
		return false;
	}

	/** Focuses a field (a block's editor or an input), with the cursor at `caret` if given. */
	private focusEl(el: HTMLElement, caret: number | null = null) {
		const editor = this.mountText(el);
		if (editor) return editor.focus(caret ?? undefined);
		el.focus();
		if (caret !== null && el.instanceOf(HTMLInputElement)) el.setSelectionRange(caret, caret);
	}

	private focusedEditor(): RichEditor | null {
		for (const ed of this.editors) if (ed.hasFocus) return ed;
		return null;
	}

	/** CodeMirror listens on the whole document, so editors are destroyed whenever the script is redrawn. */
	private destroyEditors() {
		if (this.formatTarget) this.hideFormatBar();
		for (const ed of this.editors) ed.destroy();
		this.editors.clear();
	}

	// ---------------------------------------------------------------- freestyle blocks

	private applyFreeClasses(el: HTMLElement, f: FreeFormat) {
		el.addClass("st-free", `st-free-${f.align}`, `st-free-${f.size}`);
		el.toggleClass("st-free-indent", f.indent);
		el.toggleClass("st-free-box", f.box);
	}

	/** Changes a freestyle block's layout (undoable) and keeps the cursor in it. */
	private setFree(block: Block, change: Partial<FreeFormat>) {
		const ed = this.focusedEditor();
		const keepCaret = ed && this.editorBlocks.get(ed) === block ? ed.selection.from : null;
		this.focusAfterRender = block.id;
		this.focusSelector = ".st-text";
		this.focusCaret = keepCaret;
		this.mutate(() => (block.format = { ...freeFormat(block), ...change }));
	}

	/** Small toolbar shown above a freestyle block while it's focused or hovered. */
	private freeToolbar(el: HTMLElement, block: Block, f: FreeFormat) {
		const bar = el.createDiv({ cls: "st-free-bar", attr: { role: "toolbar", "aria-label": "Freestyle format" } });
		const btn = (icon: string, fallback: string, label: string, active: boolean, change: Partial<FreeFormat>) => {
			const b = bar.createEl("button", { cls: "st-free-btn" + (active ? " is-active" : ""), attr: { "aria-label": label, "aria-pressed": String(active) } });
			setIcon(b, icon);
			// Icon sets differ between Obsidian versions: never leave a blank button.
			if (!b.querySelector("svg")) b.setText(fallback);
			b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the text
			b.addEventListener("click", () => this.setFree(block, change));
		};
		btn("align-left", "←", "Align left", f.align === "left", { align: "left" });
		btn("align-center", "↔", "Centre", f.align === "center", { align: "center" });
		btn("align-right", "→", "Align right", f.align === "right", { align: "right" });
		bar.createDiv("st-free-sep");
		btn("indent", "⇥", "Indent to dialogue column", f.indent, { indent: !f.indent });
		btn("square", "□", "Box around it", f.box, { box: !f.box });
		bar.createDiv("st-free-sep");
		const order: FreeFormat["size"][] = ["small", "normal", "large"];
		const i = order.indexOf(f.size);
		btn("a-arrow-down", "A−", "Smaller text", false, { size: order[Math.max(0, i - 1)] });
		btn("a-arrow-up", "A+", "Larger text", false, { size: order[Math.min(order.length - 1, i + 1)] });
	}

	/** Ctrl+B / Ctrl+I / Ctrl+U → the style to toggle (Ctrl+Shift+H is handled separately: see toggleQuickHighlight). */
	private shortcutStyle(e: KeyboardEvent): StyleKey | null {
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
		const k = e.key.toLowerCase();
		if (k === "b") return "bold";
		if (k === "i") return "italic";
		if (k === "u") return "underline";
		return null;
	}

	/** The words with comments in a block (and the draft comment's), for its editor to mark. */
	private commentSpans(block: Block): CommentSpan[] {
		const spans: CommentSpan[] = [];
		for (const n of this.visibleNotes(block.notes)) {
			if (n.range) spans.push({ start: n.range.start, end: n.range.end, active: n.id === this.activeNote });
		}
		if (this.draftRange && this.draftTarget === block.id) spans.push({ ...this.draftRange, active: true });
		return spans;
	}

	private repaintComments() {
		const marked = (block: Block | undefined) => !!block && (block.notes.some((n) => n.range) || this.draftTarget === block.id);
		for (const ed of this.editors) if (marked(this.editorBlocks.get(ed))) ed.refreshDecorations();
		this.scriptEl?.querySelectorAll<HTMLElement>(".st-text-static").forEach((host) => {
			if (marked(this.staticBlocks.get(host))) this.paintStatic(host);
		});
	}

	/** Putting the cursor in commented words brings their comment forward, as in Word. */
	private activateNoteAtCaret(editor: RichEditor) {
		const block = this.editorBlocks.get(editor);
		if (!block || !this.marginOpen || !editor.hasFocus) return;
		const at = editor.selection.from;
		const hits = this.visibleNotes(block.notes).filter((n) => n.range && n.range.start < n.range.end && n.range.start <= at && at <= n.range.end);
		if (!hits.length) return;
		// Innermost first, when comments overlap.
		hits.sort((a, b) => a.range!.end - a.range!.start - (b.range!.end - b.range!.start));
		if (hits[0].id !== this.activeNote) this.setActiveNote(hits[0].id);
	}

	/** Opens a draft comment on just the selected words of a block. */
	private commentOnSelection(editor: RichEditor) {
		const block = this.editorBlocks.get(editor);
		if (!block) return;
		const text = editor.text;
		let { from: start, to: end } = editor.selection;
		while (start < end && /\s/.test(text[start])) start++;
		while (end > start && /\s/.test(text[end - 1])) end--;
		if (start === end) return new Notice("Select the words you want to comment on.");
		this.hideFormatBar();
		this.draftTarget = block.id;
		this.draftRange = { start, end };
		this.editingNote = null;
		this.marginOpen = true;
		this.renderAll();
	}

	/** Keeps a block's word comment cards level with their words as the text changes. */
	private refreshCardAnchors(block: Block) {
		for (const n of block.notes) {
			if (n.range) this.marginEl?.querySelector<HTMLElement>(`.st-comment[data-note="${n.id}"]`)?.setAttr("data-start", String(n.range.start));
		}
		this.queueLayout();
	}

	// ---------------------------------------------------------------- formatting

	/** Bold / italic / underline on the selected words, or for what's typed next if nothing is selected. */
	private applyFormat(editor: RichEditor, key: StyleKey) {
		if (editor.readOnly) return new Notice("This block is locked.");
		editor.toggle(key);
		this.updateFormatBar(editor);
	}

	/** Sets (or clears) the highlight colour of the selected words only — never the whole block. */
	private applyHighlight(editor: RichEditor, color: HighlightColor | null) {
		if (editor.readOnly) return new Notice("This block is locked.");
		editor.setHighlight(color);
		this.hideHighlightPopover();
		this.updateFormatBar(editor);
	}

	/** Ctrl+Shift+H: toggles the default (yellow) highlight on the selected words. */
	private toggleQuickHighlight(editor: RichEditor) {
		this.applyHighlight(editor, editor.selectionStyle().highlight === "yellow" ? null : "yellow");
	}

	private updateFormatBar(editor: RichEditor) {
		const { from, to } = editor.selection;
		if (!editor.hasFocus || editor.readOnly || from === to) {
			if (this.formatTarget === editor) this.hideFormatBar();
			return;
		}
		this.formatTarget = editor;
		const bar = (this.formatBar ??= this.buildFormatBar());
		if (bar.parentElement !== this.contentEl) this.contentEl.appendChild(bar);
		// Show which styles the whole selection already has (the button would remove them).
		const style = editor.selectionStyle();
		bar.querySelectorAll<HTMLElement>("[data-style]").forEach((b) => b.toggleClass("is-active", style[b.dataset.style as StyleKey]));
		const hlBtn = bar.querySelector<HTMLElement>(".st-format-btn-highlight");
		hlBtn?.toggleClass("is-active", !!style.highlight);
		hlBtn?.setCssProps({ "--st-active-highlight": style.highlight ? `var(--st-hl-${style.highlight})` : "" });
		if (this.highlightPopover?.hasClass("is-visible")) this.fillHighlightPopover(style.highlight);
		bar.addClass("is-visible");
		this.positionFormatBar();
	}

	private buildFormatBar(): HTMLElement {
		const bar = createDiv({ cls: "st-format-bar", attr: { role: "toolbar", "aria-label": "Text formatting" } });
		const buttons: [StyleKey, string, string, string][] = [
			["bold", "bold", "Bold", "Ctrl+B"],
			["italic", "italic", "Italic", "Ctrl+I"],
			["underline", "underline", "Underline", "Ctrl+U"],
		];
		for (const [key, icon, name, keys] of buttons) {
			const b = bar.createEl("button", { cls: "st-format-btn", attr: { "aria-label": `${name} (${keys})`, "data-style": key } });
			setIcon(b, icon);
			// Keep the text selected: don't let the button take focus.
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", () => this.formatTarget && this.applyFormat(this.formatTarget, key));
		}
		const hlBtn = bar.createEl("button", {
			cls: "st-format-btn st-format-btn-highlight",
			attr: { "aria-label": "Highlight (Ctrl+Shift+H) — pick a colour", "aria-haspopup": "true" },
		});
		setIcon(hlBtn, "highlighter");
		hlBtn.addEventListener("mousedown", (e) => e.preventDefault());
		hlBtn.addEventListener("click", () => this.toggleHighlightPopover());
		bar.createSpan("st-format-sep");
		const cmtBtn = bar.createEl("button", { cls: "st-format-btn st-format-btn-comment", attr: { "aria-label": "Comment on these words (Ctrl+Alt+M)" } });
		setIcon(cmtBtn, "message-square-plus");
		cmtBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cmtBtn.addEventListener("click", () => this.formatTarget && this.commentOnSelection(this.formatTarget));
		return bar;
	}

	/** Small colour-swatch dropdown for the highlighter button, like Word's highlight picker. */
	private buildHighlightPopover(): HTMLElement {
		const pop = createDiv({ cls: "st-highlight-pop", attr: { role: "menu", "aria-label": "Highlight colour" } });
		for (const color of HIGHLIGHT_COLORS) {
			const swatch = pop.createEl("button", { cls: "st-highlight-swatch", attr: { "data-color": color, "aria-label": color } });
			swatch.setCssProps({ "--st-swatch": `var(--st-hl-${color})` });
			swatch.addEventListener("mousedown", (e) => e.preventDefault());
			swatch.addEventListener("click", () => {
				const ed = this.formatTarget;
				if (!ed) return;
				this.applyHighlight(ed, ed.selectionStyle().highlight === color ? null : color);
			});
		}
		const remove = pop.createEl("button", { cls: "st-highlight-swatch st-highlight-none", attr: { "aria-label": "Remove highlight" } });
		setIcon(remove, "x");
		remove.addEventListener("mousedown", (e) => e.preventDefault());
		remove.addEventListener("click", () => this.formatTarget && this.applyHighlight(this.formatTarget, null));
		return pop;
	}

	/** Checks the swatch matching the selection's current highlight colour, if any. */
	private fillHighlightPopover(current: HighlightColor | null) {
		this.highlightPopover?.querySelectorAll<HTMLElement>(".st-highlight-swatch").forEach((s) => {
			s.toggleClass("is-active", !!current && s.dataset.color === current);
		});
	}

	private toggleHighlightPopover() {
		const pop = (this.highlightPopover ??= this.buildHighlightPopover());
		if (pop.hasClass("is-visible")) {
			this.hideHighlightPopover();
			return;
		}
		if (pop.parentElement !== this.contentEl) this.contentEl.appendChild(pop);
		if (this.formatTarget) this.fillHighlightPopover(this.formatTarget.selectionStyle().highlight);
		pop.addClass("is-visible");
		this.positionHighlightPopover();
	}

	private hideHighlightPopover() {
		this.highlightPopover?.removeClass("is-visible");
	}

	/** Anchors the popover under the highlighter button, inside the format bar. */
	private positionHighlightPopover() {
		const pop = this.highlightPopover;
		const bar = this.formatBar;
		const btn = bar?.querySelector<HTMLElement>(".st-format-btn-highlight");
		if (!pop || !bar || !btn) return;
		const at = btn.getBoundingClientRect();
		const host = this.contentEl.getBoundingClientRect();
		const left = Math.max(8, Math.min(at.left - host.left, host.width - pop.offsetWidth - 8));
		const top = at.bottom - host.top + 6;
		pop.setCssStyles({ left: left + "px", top: top + "px" });
	}

	/** Places the bar just above the start of the selection (below it near the top edge). */
	private positionFormatBar() {
		const bar = this.formatBar;
		const ed = this.formatTarget;
		if (!bar || !ed || !bar.hasClass("is-visible")) return;
		const at = ed.coordsAt(ed.selection.from) ?? ed.dom.getBoundingClientRect();
		const host = this.contentEl.getBoundingClientRect();
		const w = bar.offsetWidth;
		const h = bar.offsetHeight;
		let left = at.left - host.left - 6;
		let top = at.top - host.top - h - 8;
		if (top < 44) top = at.bottom - host.top + 8; // no room above: drop below the line
		left = Math.max(8, Math.min(left, host.width - w - 8));
		bar.setCssStyles({ left: left + "px", top: top + "px" });
		if (this.highlightPopover?.hasClass("is-visible")) this.positionHighlightPopover();
	}

	private hideFormatBar() {
		this.formatBar?.removeClass("is-visible");
		this.hideHighlightPopover();
		this.formatTarget = null;
	}

	// ---------------------------------------------------------------- keyboard flow

	/**
	 * Lets the title, byline and speaker inputs work like the rest of the document:
	 * ↑/↓ cross between fields, Enter leaves the title lines, Alt+↑/↓ moves the current block,
	 * Esc leaves the field (so Ctrl+Z undoes structure). Block text does the same in editorKeys.
	 */
	private wireFieldKeys(el: HTMLElement) {
		el.addEventListener("keydown", (e) => {
			const t = e.target as HTMLElement;
			if (!t.closest(".st-sheet") || !t.instanceOf(HTMLInputElement)) return;
			const field = t;
			const mod = e.ctrlKey || e.metaKey;

			if (e.key === "Escape") {
				this.hideFormatBar();
				this.contentEl.focus({ preventScroll: true });
				return;
			}
			if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
				const block = t.closest<HTMLElement>(".st-block");
				if (!block) return;
				e.preventDefault();
				this.moveBlockBy(block.dataset.id!, e.key === "ArrowUp" ? -1 : 1, "input.st-speaker", field.selectionStart ?? 0);
				return;
			}
			if (mod || e.altKey || e.shiftKey) return;

			const isTitle = field.hasClass("st-title") || field.hasClass("st-byline");
			if (e.key === "Enter" && isTitle) {
				e.preventDefault();
				this.focusField(field, 1);
				return;
			}
			// Speaker fields keep ↑/↓ for their autocomplete list.
			if (field.hasAttribute("list")) return;
			if (e.key === "ArrowDown" && this.focusField(field, 1)) e.preventDefault();
			else if (e.key === "ArrowUp" && this.focusField(field, -1)) e.preventDefault();
		});
	}

	/** Moves focus to the next/previous text field on the paper. */
	private focusField(from: HTMLElement, dir: 1 | -1): boolean {
		const fields = Array.from(this.scriptEl.querySelectorAll<HTMLElement>(".st-sheet input.st-title, .st-sheet input.st-byline, .st-sheet input.st-speaker, .st-sheet .st-text"));
		const next = fields[fields.indexOf(from) + dir];
		if (!next) return false;
		const editor = this.mountText(next);
		if (editor) editor.focus(dir === 1 ? "start" : "end");
		else if (next.instanceOf(HTMLInputElement)) {
			next.focus();
			const pos = dir === 1 ? 0 : next.value.length;
			next.setSelectionRange(pos, pos);
		}
		next.scrollIntoView({ block: "nearest" });
		return true;
	}

	/** Alt+↑/↓: moves a block within its panel, or into the neighbouring panel at the edges. */
	private moveBlockBy(id: string, dir: -1 | 1, fieldSelector: string, caret: number) {
		const ref = findRef(this.doc, id);
		if (!ref?.panel || ref.blockIndex === undefined) return;
		if (isLocked(ref)) return new Notice("This block is locked.");
		const blocks = ref.panel.blocks;
		const to = ref.blockIndex + dir;
		const panels = [...walk(this.doc)].filter((r) => r.kind === "panel" && !isLocked(r)).map((r) => r.panel!);
		const neighbour = to < 0 || to >= blocks.length ? panels[panels.indexOf(ref.panel) + dir] : null;
		if ((to < 0 || to >= blocks.length) && !neighbour) return;
		this.focusAfterRender = id;
		this.focusSelector = fieldSelector;
		this.focusCaret = caret;
		this.mutate(() => {
			const [b] = blocks.splice(ref.blockIndex!, 1);
			if (neighbour) {
				neighbour.collapsed = false;
				if (dir < 0) neighbour.blocks.push(b);
				else neighbour.blocks.unshift(b);
			} else blocks.splice(to, 0, b);
		});
	}

	private speakerText(block: Block): string {
		return block.speaker + (block.modifier ? ` (${block.modifier})` : "");
	}

	/** "MAYA (off)" → speaker MAYA, modifier off. The modifier keeps its case, as in the template. */
	private parseSpeaker(block: Block, value: string) {
		const i = value.indexOf("(");
		if (i < 0) {
			block.speaker = value.trim();
			block.modifier = "";
		} else {
			block.speaker = value.slice(0, i).trim();
			block.modifier = value.slice(i + 1).replace(/\)\s*$/, "").trim();
		}
	}

	/** Text input that grows with its content, so "CHARACTER (off):" reads as one run of text. */
	private sizedInput(parent: HTMLElement, cls: string, placeholder: string): HTMLInputElement {
		const input = parent.createEl("input", { cls, attr: { type: "text", placeholder, spellcheck: "false" } });
		input.addEventListener("input", () => this.fitInput(input));
		// Roomier while editing (see fitInput), snug again afterwards.
		input.addEventListener("focus", () => this.fitInput(input));
		input.addEventListener("blur", () => this.fitInput(input, false));
		window.requestAnimationFrame(() => this.fitInput(input));
		return input;
	}

	/**
	 * Sizes a speaker field to its text. The paper uses a monospace font, so character
	 * units fit exactly. While the field is being edited it's widened to the longest
	 * autocomplete name that matches what's typed (plus room for the cursor): the
	 * browser previews a highlighted suggestion inside the field without any event,
	 * and an exact-fit field would cut that preview off ("URCH" instead of "URCHIN").
	 */
	private fitInput(input: HTMLInputElement, editing = input.ownerDocument.activeElement === input) {
		let chars = Math.max(input.value.length || input.placeholder.length, 1);
		if (editing) {
			const typed = input.value.trim().toUpperCase();
			const listId = input.getAttribute("list");
			const options = listId ? Array.from(input.ownerDocument.querySelectorAll<HTMLOptionElement>(`datalist[id="${listId}"] option`)) : [];
			for (const o of options) if (o.value.toUpperCase().startsWith(typed)) chars = Math.max(chars, o.value.length);
			chars += 1;
		}
		// +2px: the browser rounds the field's width down, which would otherwise clip the last letter.
		input.setCssStyles({ width: `calc(${chars}ch + 2px)` });
	}

	/** Container element shared by pages, panels and blocks: revision, lock and pin state. */
	private itemShell(parent: HTMLElement, kind: ItemKind, ref: ItemRef): HTMLElement {
		const item = ref.item;
		const el = parent.createDiv({ cls: `st-item st-${kind}`, attr: { "data-id": item.id, "data-drag-item": "" } });
		el.toggleClass("is-revision", item.revision);
		el.toggleClass("is-locked", isLocked(ref));
		el.toggleClass("is-pinned", item.pinned);
		// Comments on some of the words mark just those words, not the whole item.
		el.toggleClass("has-comments", item.notes.some((n) => !n.resolved && !n.range));
		el.addEventListener("contextmenu", (e) => {
			// Shift+right-click keeps the normal text menu (spellcheck, paste…).
			if (e.shiftKey) return;
			e.preventDefault();
			e.stopPropagation();
			this.itemMenu(e, ref);
		});
		if (item.notes.some((n) => !n.range)) {
			el.addEventListener("focusin", (e) => {
				if ((e.target as HTMLElement).closest("[data-id]") !== el) return;
				const note = item.notes.find((n) => !n.range && (this.showResolved || !n.resolved));
				if (note && this.marginOpen) this.setActiveNote(note.id);
			});
		}
		return el;
	}

	private collapseToggle(gutter: HTMLElement, label: HTMLElement, item: Page | Panel) {
		const b = this.iconBtn(gutter, item.collapsed ? "chevron-right" : "chevron-down", item.collapsed ? "Expand" : "Collapse", () => {
			this.capture();
			item.collapsed = !item.collapsed;
			this.requestSave();
			this.renderAll();
		}, "st-collapse");
		if (item.collapsed) b.addClass("is-collapsed");
		label.addEventListener("dblclick", (e) => {
			if ((e.target as HTMLElement).closest("button, input, textarea, .st-text")) return;
			b.click();
		});
	}

	/** Small status markers: revision, pinned, locked. */
	private badges(parent: HTMLElement, ref: ItemRef) {
		const item = ref.item;
		const locked = isLocked(ref);
		if (!item.revision && !item.pinned && !item.locked) return;
		const wrap = parent.createSpan("st-badges");
		if (item.revision) wrap.createSpan({ cls: "st-badge st-badge-revision", text: "REVISE" });
		if (item.pinned) setIcon(wrap.createSpan({ cls: "st-badge st-badge-icon", attr: { "aria-label": "Pinned" } }), "pin");
		if (item.locked && locked) setIcon(wrap.createSpan({ cls: "st-badge st-badge-icon", attr: { "aria-label": "Locked" } }), "lock");
	}

	private dragHandle(gutter: HTMLElement, itemEl: HTMLElement, ref: ItemRef, locked: boolean) {
		const h = gutter.createSpan({ cls: "st-handle", attr: { "aria-label": locked ? "Locked" : "Drag to move · right-click for options" } });
		setIcon(h, "grip-vertical");
		h.addEventListener("click", (e) => this.itemMenu(e, ref));
		// Containers that are locked can't lose children either, so check the source container too.
		const sourceLocked = locked || (ref.kind === "panel" && ref.page.locked) || (ref.kind === "block" && (ref.panel?.locked || ref.page.locked));
		if (sourceLocked) {
			h.addClass("is-disabled");
			return;
		}
		// Only make the item draggable while the handle is held, so text selection in fields still works.
		h.addEventListener("mousedown", () => itemEl.setAttr("draggable", "true"));
		h.addEventListener("mouseup", () => itemEl.removeAttribute("draggable"));
		itemEl.addEventListener("dragstart", (e) => {
			if (e.target !== itemEl) return;
			this.startDrag(e, { kind: ref.kind, id: ref.item.id }, itemEl);
		});
	}

	/** Binds an input to the model without re-rendering, with one undo step per editing session. */
	private bindText(el: HTMLInputElement, set: (v: string) => void) {
		el.addEventListener("focus", () => (this.pendingSnapshot = JSON.stringify(this.doc)));
		el.addEventListener("input", () => {
			if (el.readOnly) return;
			this.beginEdit();
			set(el.value);
			this.requestSave();
			this.updateStats();
		});
	}

	/** The first change after focusing a field makes one undo step for the whole editing session. */
	private beginEdit() {
		if (!this.pendingSnapshot) return;
		this.undoStack.push(this.pendingSnapshot);
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
		this.pendingSnapshot = null;
		this.updateHistoryButtons();
	}

	private updatePanelCount(panel: Panel) {
		const el = this.panelCountEls.get(panel.id);
		if (!el) return;
		const words = panelLetteringWords(panel, this.plugin.settings);
		el.setText(words ? `${words} lettering word${words === 1 ? "" : "s"}` : "");
		el.toggleClass("is-warning", words > 35);
	}

	private refreshSpeakers() {
		if (!this.datalistEl) return;
		this.datalistEl.empty();
		for (const s of collectSpeakers(this.doc)) this.datalistEl.createEl("option", { attr: { value: s } });
	}

	// ---------------------------------------------------------------- context menu

	/** Adds a submenu where supported (Obsidian 1.5+), otherwise inlines the items. */
	private submenu(menu: Menu, title: string, icon: string, fill: (m: Menu) => void) {
		let sub: Menu | undefined;
		menu.addItem((i) => {
			i.setTitle(title).setIcon(icon);
			// Submenus exist since Obsidian 1.5 but aren't in the public typings; fall back to a flat menu.
			sub = (i as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.();
		});
		if (sub) fill(sub);
		else fill(menu);
	}

	private itemMenu(e: MouseEvent, ref: ItemRef) {
		const menu = new Menu();
		const item = ref.item;
		const locked = isLocked(ref);
		const containerLocked = ref.kind === "page" ? false : ref.kind === "panel" ? ref.page.locked : !!(ref.page.locked || ref.panel?.locked);
		const settings = this.plugin.settings;

		const host = (e.target as HTMLElement).closest?.<HTMLElement>(".st-text");
		const ed = host ? this.editorOf.get(host) : undefined;
		if (ed && ed.selection.from !== ed.selection.to && this.editorBlocks.get(ed) === item) {
			menu.addItem((i) => i.setTitle("Comment on selected words").setIcon("quote").onClick(() => this.commentOnSelection(ed)));
		}
		menu.addItem((i) => i.setTitle(ref.kind === "block" ? "Comment on whole block" : "Note or comment").setIcon("message-square-plus").onClick(() => this.startComment(item.id)));
		menu.addSeparator();

		menu.addItem((i) => i.setTitle(item.pinned ? "Unpin" : "Pin").setIcon("pin").onClick(() => this.mutate(() => (item.pinned = !item.pinned))));
		menu.addItem((i) =>
			i.setTitle(item.revision ? "Clear revision mark" : "Mark for revision").setIcon("flag").onClick(() => this.mutate(() => (item.revision = !item.revision)))
		);
		if (item.locked || !locked) {
			menu.addItem((i) => i.setTitle(item.locked ? "Unlock" : "Lock").setIcon(item.locked ? "unlock" : "lock").onClick(() => this.mutate(() => (item.locked = !item.locked))));
		}
		menu.addSeparator();

		if (ref.kind === "page") {
			const page = ref.page;
			if (!locked) menu.addItem((i) => i.setTitle("Add panel").setIcon("plus").onClick(() => this.mutate(() => page.panels.push(newPanel(settings)))));
			menu.addItem((i) => i.setTitle("Insert page after").setIcon("file-plus").onClick(() => this.mutate(() => this.doc.pages.splice(ref.pageIndex + 1, 0, newPage(settings)))));
			if (this.doc.pages.length > 1) {
				menu.addItem((i) => i.setTitle("Swap with page\u2026").setIcon("arrow-left-right").onClick(() => this.pickPage(page.id, "swap")));
				menu.addItem((i) => i.setTitle("Move to position\u2026").setIcon("move-vertical").onClick(() => this.pickPage(page.id, "move")));
			}
			menu.addItem((i) => i.setTitle("Collapse all panels").setIcon("chevrons-down-up").onClick(() => this.mutate(() => page.panels.forEach((p) => (p.collapsed = true)))));
			menu.addItem((i) => i.setTitle("Expand all panels").setIcon("chevrons-up-down").onClick(() => this.mutate(() => page.panels.forEach((p) => (p.collapsed = false)))));
		} else if (ref.kind === "panel") {
			const panel = ref.panel!;
			if (!locked) {
				this.submenu(menu, "Add block", "plus", (m) => {
					for (const t of settings.blockTypes) m.addItem((s) => s.setTitle(t.name).onClick(() => this.insertBlockAt(panel, panel.blocks.length, newBlock(t))));
				});
			}
			if (!containerLocked) menu.addItem((i) => i.setTitle("Insert panel after").setIcon("plus-square").onClick(() => this.insertPanelAfter(ref)));
		} else {
			const block = ref.block!;
			if (!locked) {
				this.submenu(menu, "Change type", "replace", (m) => {
					for (const t of settings.blockTypes) {
						m.addItem((i) => i.setTitle(t.name).setChecked(block.typeId === t.id).onClick(() => this.changeType(block, t)));
					}
				});
			}
			if (!containerLocked) {
				this.submenu(menu, "Insert below", "plus", (m) => {
					for (const t of settings.blockTypes) m.addItem((s) => s.setTitle(t.name).onClick(() => this.insertBlockAt(ref.panel!, ref.blockIndex! + 1, newBlock(t))));
				});
			}
			if (!locked && findType(settings, block.typeId).style === "freestyle") {
				const f = freeFormat(block);
				this.submenu(menu, "Freestyle format", "type", (m) => {
					for (const [align, label] of [["left", "Align left"], ["center", "Centre"], ["right", "Align right"]] as const) {
						m.addItem((i) => i.setTitle(label).setChecked(f.align === align).onClick(() => this.setFree(block, { align })));
					}
					m.addItem((i) => i.setTitle("Indent to dialogue column").setChecked(f.indent).onClick(() => this.setFree(block, { indent: !f.indent })));
					for (const [size, label] of [["small", "Small text"], ["normal", "Normal text"], ["large", "Large text"]] as const) {
						m.addItem((i) => i.setTitle(label).setChecked(f.size === size).onClick(() => this.setFree(block, { size })));
					}
					m.addItem((i) => i.setTitle("Box around it").setChecked(f.box).onClick(() => this.setFree(block, { box: !f.box })));
				});
			}
			menu.addItem((i) => i.setTitle("Save as reusable block").setIcon("bookmark-plus").onClick(() => this.saveAsPreset(block)));
		}

		if (!containerLocked) {
			menu.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(() => this.duplicate(ref)));
			// Keyboard/touch alternative to dragging.
			if (!locked) {
				const list = this.siblings(ref);
				const idx = list.indexOf(item);
				if (idx > 0) menu.addItem((i) => i.setTitle("Move up").setIcon("arrow-up").onClick(() => this.mutate(() => list.splice(idx - 1, 0, list.splice(idx, 1)[0]))));
				if (idx < list.length - 1) menu.addItem((i) => i.setTitle("Move down").setIcon("arrow-down").onClick(() => this.mutate(() => list.splice(idx + 1, 0, list.splice(idx, 1)[0]))));
			}
		}
		if (!locked && !containerLocked) {
			menu.addSeparator();
			menu.addItem((i) => {
				i.setTitle("Delete " + ref.kind).setIcon("trash").onClick(() => this.remove(ref));
				i.setWarning(true);
			});
		}
		menu.showAtMouseEvent(e);
	}

	private changeType(block: Block, t: BlockType) {
		this.mutate(() => {
			const old = findType(this.plugin.settings, block.typeId);
			if (!block.speaker || block.speaker === old.defaultSpeaker) block.speaker = t.defaultSpeaker;
			block.typeId = t.id;
		});
	}

	// ---------------------------------------------------------------- operations

	addPage() {
		const page = newPage(this.plugin.settings);
		this.mutate(() => this.doc.pages.push(page));
		this.jumpTo(page.id);
	}

	setAllCollapsed(collapsed: boolean) {
		this.mutate(() => {
			for (const page of this.doc.pages) {
				page.collapsed = collapsed;
				if (!collapsed) page.panels.forEach((p) => (p.collapsed = false));
			}
		});
	}

	private activePanelRef(): ItemRef | null {
		if (this.activePanelId) {
			const ref = findRef(this.doc, this.activePanelId);
			if (ref) return ref;
		}
		const page = this.doc.pages[this.doc.pages.length - 1];
		const panel = page?.panels[page.panels.length - 1];
		return panel ? findRef(this.doc, panel.id) : null;
	}

	private addBlockToActivePanel(block: Block) {
		const ref = this.activePanelRef();
		if (!ref?.panel) return new Notice("Add a panel first.");
		if (isLocked(ref)) return new Notice("That panel is locked.");
		this.insertBlockAt(ref.panel, ref.panel.blocks.length, block);
		this.jumpTo(block.id);
	}

	private addPanelToActivePage() {
		const ref = this.activePanelRef();
		const page = ref?.page ?? this.doc.pages[this.doc.pages.length - 1];
		if (!page) return this.addPage();
		if (page.locked) return new Notice("That page is locked.");
		const panel = newPanel(this.plugin.settings);
		this.mutate(() => page.panels.push(panel));
		this.jumpTo(panel.id);
	}

	private insertBlockAt(panel: Panel, index: number, block: Block) {
		this.focusAfterRender = block.id;
		this.mutate(() => {
			panel.collapsed = false;
			panel.blocks.splice(index, 0, block);
		});
	}

	private insertBlockAfter(ref: ItemRef, typeId: string) {
		const type = findType(this.plugin.settings, typeId);
		this.insertBlockAt(ref.panel!, (ref.blockIndex ?? -1) + 1, newBlock(type));
	}

	private insertPanelAfter(ref: ItemRef) {
		if (ref.page.locked) return new Notice("That page is locked.");
		const panel = newPanel(this.plugin.settings);
		this.focusAfterRender = panel.blocks[0]?.id ?? null;
		this.mutate(() => ref.page.panels.splice((ref.panelIndex ?? -1) + 1, 0, panel));
	}

	private siblings(ref: ItemRef): (Page | Panel | Block)[] {
		if (ref.kind === "page") return this.doc.pages;
		if (ref.kind === "panel") return ref.page.panels;
		return ref.panel!.blocks;
	}

	private duplicate(ref: ItemRef) {
		this.mutate(() => {
			if (ref.kind === "page") this.doc.pages.splice(ref.pageIndex + 1, 0, cloneWithNewIds(ref.page));
			else if (ref.kind === "panel") ref.page.panels.splice(ref.panelIndex! + 1, 0, cloneWithNewIds(ref.panel!));
			else ref.panel!.blocks.splice(ref.blockIndex! + 1, 0, cloneWithNewIds(ref.block!));
		});
	}

	private remove(ref: ItemRef) {
		const id = ref.item.id;
		const commit = () => {
			const r = findRef(this.doc, id);
			if (!r) return;
			this.mutate(() => {
				if (r.kind === "page") this.doc.pages.splice(r.pageIndex, 1);
				else if (r.kind === "panel") r.page.panels.splice(r.panelIndex!, 1);
				else r.panel!.blocks.splice(r.blockIndex!, 1);
			});
			this.undoNotice(`Deleted ${r.kind}.`);
		};
		const el = this.scriptEl?.querySelector<HTMLElement>(`.st-sheet [data-id="${id}"]`);
		if (!el || !this.motion) return commit();
		el.addClass("st-exit");
		window.setTimeout(commit, 140);
	}

	private saveAsPreset(block: Block) {
		const type = findType(this.plugin.settings, block.typeId);
		const suggested = (block.speaker ? block.speaker + ": " : type.name + ": ") + block.text.slice(0, 24);
		new PromptModal(this.app, "Save as reusable block", suggested, (name) => {
			this.plugin.settings.presets.push({ id: uid(), name, typeId: block.typeId, speaker: block.speaker, modifier: block.modifier, text: block.text });
			void this.plugin.saveSettings({ from: this, scope: "palette" });
			new Notice(`Saved “${name}” to the palette.`);
		}).open();
	}

	/** Expands any collapsed ancestors, scrolls to the item and flashes it. */
	jumpTo(id: string, onlyIfHidden = false) {
		const ref = findRef(this.doc, id);
		if (!ref) return;
		let changed = false;
		this.capture();
		if (ref.kind !== "page" && ref.page.collapsed) {
			ref.page.collapsed = false;
			changed = true;
		}
		if (ref.kind === "block" && ref.panel?.collapsed) {
			ref.panel.collapsed = false;
			changed = true;
		}
		if (changed) {
			this.requestSave();
			this.renderAll();
		}
		window.requestAnimationFrame(() => {
			const el = this.scriptEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
			if (!el) return;
			const r = el.getBoundingClientRect();
			const view = this.scriptEl.getBoundingClientRect();
			const visible = r.bottom > view.top + 20 && r.top < view.bottom - 20;
			if (!onlyIfHidden || !visible) el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.removeClass("st-flash");
			void el.offsetWidth;
			el.addClass("st-flash");
		});
	}

	// ---------------------------------------------------------------- comment margin

	/** Opens a new comment card beside the item, like "Insert comment" in Google Docs. */
	startComment(id: string) {
		const ref = findRef(this.doc, id);
		if (!ref) return;
		if ((ref.kind !== "page" && ref.page.collapsed) || (ref.kind === "block" && ref.panel?.collapsed)) this.jumpTo(id);
		this.draftTarget = id;
		this.draftRange = null;
		this.editingNote = null;
		this.marginOpen = true;
		this.renderAll();
		const anchor = this.scriptEl?.querySelector<HTMLElement>(`.st-sheet [data-id="${id}"]`);
		if (anchor && this.motion) playOnce(anchor, "st-pulse");
	}

	private visibleNotes(notes: SideNote[]): SideNote[] {
		return notes.filter((n) => this.showResolved || !n.resolved);
	}

	private renderMargin(canvas: HTMLElement) {
		const refs = [...walk(this.doc)].filter((r) => this.visibleNotes(r.item.notes).length);
		if (!refs.length && !this.draftTarget) return;

		const margin = (this.marginEl = canvas.createDiv("st-margin"));
		margin.toggleClass("is-collapsed", !this.marginOpen);
		const head = margin.createDiv("st-margin-head");

		if (!this.marginOpen) {
			this.iconBtn(head, "chevrons-left", "Expand comments", () => {
				this.marginOpen = true;
				this.renderAll();
			});
			const layer = margin.createDiv("st-margin-layer");
			for (const ref of refs) {
				const n = this.visibleNotes(ref.item.notes);
				const marker = layer.createDiv({ cls: "st-comment-marker", attr: { "data-anchor": ref.item.id, "aria-label": `${n.length} comment${n.length === 1 ? "" : "s"}` } });
				setIcon(marker.createSpan(), "message-square");
				marker.createSpan({ text: String(n.length) });
				marker.addEventListener("click", () => {
					this.marginOpen = true;
					this.activeNote = n[0].id;
					this.renderAll();
				});
			}
			return;
		}

		head.createSpan({ cls: "st-margin-title", text: this.showResolved ? "Comments (incl. resolved)" : "Comments" });
		this.iconBtn(head, "chevrons-right", "Collapse comments", () => {
			this.marginOpen = false;
			this.renderAll();
		});

		const layer = margin.createDiv("st-margin-layer");
		for (const ref of refs) for (const note of this.visibleNotes(ref.item.notes)) this.renderCommentCard(layer, ref, note);
		if (this.draftTarget) {
			const target = findRef(this.doc, this.draftTarget);
			if (target) this.renderDraftCard(layer, target);
			else this.draftTarget = null;
		}
		const cards = Array.from(layer.querySelectorAll<HTMLElement>(".st-comment"));
		this.shownCards = animateRender(cards, (el) => el.dataset.note ?? "draft:" + el.dataset.anchor, this.motion ? this.shownCards : null, null, undefined, "st-card-enter");
	}

	private renderCommentCard(layer: HTMLElement, ref: ItemRef, note: SideNote) {
		const card = layer.createDiv({ cls: "st-comment", attr: { "data-anchor": ref.item.id, "data-note": note.id } });
		if (note.range) card.setAttr("data-start", String(note.range.start));
		card.toggleClass("is-resolved", note.resolved);
		card.toggleClass("is-active", this.activeNote === note.id);
		const editing = this.editingNote === note.id;
		card.toggleClass("is-editing", editing);

		const top = card.createDiv("st-comment-top");
		const author = note.author || this.plugin.settings.authorName;
		top.createDiv({ cls: "st-avatar", text: author.slice(0, 1).toUpperCase() });
		const who = top.createDiv("st-comment-who");
		who.createDiv({ cls: "st-comment-author", text: author });
		who.createDiv({ cls: "st-comment-date", text: this.formatDate(note.created) });
		this.iconBtn(top, note.resolved ? "rotate-ccw" : "check", note.resolved ? "Re-open" : "Resolve", () =>
			this.mutate(() => {
				note.resolved = !note.resolved;
				if (note.resolved && this.activeNote === note.id) this.activeNote = null;
			})
		, "st-resolve");
		this.iconBtn(top, "more-vertical", "More", (e) => {
			const menu = new Menu();
			menu.addItem((i) =>
				i.setTitle("Edit").setIcon("pencil").onClick(() => {
					this.editingNote = note.id;
					this.activeNote = note.id;
					this.draftTarget = null;
					this.renderAll();
				})
			);
			menu.addItem((i) => {
				i.setTitle("Delete").setIcon("trash").onClick(() => {
					this.mutate(() => ref.item.notes.remove(note));
					this.undoNotice("Deleted comment.");
				});
				i.setWarning(true);
			});
			menu.showAtMouseEvent(e);
		});

		if (editing) {
			const input = card.createEl("textarea", { cls: "st-comment-input", attr: { rows: "3" } });
			input.value = note.text;
			const suggest = new LinkSuggest(this.app, input, card, () => this.file?.path ?? "");
			const save = () => {
				const text = input.value.trim();
				this.editingNote = null;
				if (!text || text === note.text) return this.renderAll();
				this.mutate(() => (note.text = text));
			};
			const cancel = () => {
				this.editingNote = null;
				this.renderAll();
			};
			this.commentButtons(card, "Save", save, cancel, suggest);
			this.commentKeys(input, save, cancel);
		} else {
			const text = card.createDiv("st-comment-text");
			renderLinked(text, note.text, this.app, this.file?.path ?? "", this);
			this.foldLong(text, note.id);
		}
		if (note.replies.length) {
			const thread = card.createDiv("st-comment-thread");
			for (const reply of note.replies) this.renderReply(thread, note, reply);
		}
		if (!note.resolved && !editing) this.replyBox(card, note);

		card.createDiv({ cls: "st-comment-loc", text: describeRef(ref, this.plugin.settings) });
		card.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button, textarea, a")) return;
			this.setActiveNote(note.id);
			this.jumpTo(ref.item.id);
		});
	}

	private renderDraftCard(layer: HTMLElement, ref: ItemRef) {
		const range = this.draftRange;
		const card = layer.createDiv({ cls: "st-comment st-comment-draft is-active", attr: { "data-anchor": ref.item.id } });
		if (range) card.setAttr("data-start", String(range.start));
		const top = card.createDiv("st-comment-top");
		const author = this.plugin.settings.authorName;
		top.createDiv({ cls: "st-avatar", text: author.slice(0, 1).toUpperCase() });
		top.createDiv({ cls: "st-comment-author", text: author });
		const input = card.createEl("textarea", { cls: "st-comment-input", attr: { rows: "3", placeholder: "Add a note or comment… type [[ to link a note" } });
		const suggest = new LinkSuggest(this.app, input, card, () => this.file?.path ?? "");
		const submit = () => {
			const text = input.value.trim();
			if (!text) return;
			const note: SideNote = { id: uid(), text, author, created: Date.now(), resolved: false, replies: [] };
			if (range) note.range = { ...range };
			this.draftTarget = null;
			this.draftRange = null;
			this.activeNote = note.id;
			this.mutate(() => ref.item.notes.push(note));
		};
		const cancel = () => {
			this.draftTarget = null;
			this.draftRange = null;
			this.renderAll();
		};
		this.commentButtons(card, "Comment", submit, cancel, suggest);
		this.commentKeys(input, submit, cancel);
		card.createDiv({ cls: "st-comment-loc", text: describeRef(ref, this.plugin.settings) });
	}

	private renderReply(thread: HTMLElement, note: SideNote, reply: NoteReply) {
		const row = thread.createDiv({ cls: "st-reply", attr: { "data-reply": reply.id } });
		const top = row.createDiv("st-comment-top");
		const author = reply.author || this.plugin.settings.authorName;
		top.createDiv({ cls: "st-avatar st-avatar-small", text: author.slice(0, 1).toUpperCase() });
		const who = top.createDiv("st-comment-who");
		who.createDiv({ cls: "st-comment-author", text: author });
		who.createDiv({ cls: "st-comment-date", text: this.formatDate(reply.created) });
		this.iconBtn(top, "trash-2", "Delete reply", () => {
			this.mutate(() => note.replies.remove(reply));
			this.undoNotice("Deleted reply.");
		}, "st-reply-delete");
		const text = row.createDiv("st-comment-text");
		renderLinked(text, reply.text, this.app, this.file?.path ?? "", this);
		this.foldLong(text, reply.id);
	}

	/** Folds long comment text to a few lines, with a "Show more" / "Show less" toggle under it. */
	private foldLong(text: HTMLElement, id: string) {
		const open = this.expandedText.has(id);
		text.toggleClass("is-folded", !open);
		// Measured once the card is on screen; short text is left alone.
		window.requestAnimationFrame(() => {
			if (!text.isConnected) return;
			const line = parseFloat(getComputedStyle(text).lineHeight) || 19;
			if (text.scrollHeight <= line * FOLD_LINES + 2) {
				text.removeClass("is-folded");
				return;
			}
			const btn = createEl("button", { cls: "st-show-more", text: open ? "Show less" : "Show more" });
			btn.setAttr("aria-expanded", String(open));
			text.after(btn);
			btn.addEventListener("click", () => {
				const nowOpen = !this.expandedText.has(id);
				if (nowOpen) this.expandedText.add(id);
				else this.expandedText.delete(id);
				text.toggleClass("is-folded", !nowOpen);
				btn.setText(nowOpen ? "Show less" : "Show more");
				btn.setAttr("aria-expanded", String(nowOpen));
				this.queueLayout();
			});
			this.queueLayout();
		});
	}

	/** The "Reply" field under a comment, shown on the selected card as in Word. */
	private replyBox(card: HTMLElement, note: SideNote) {
		const box = card.createDiv("st-reply-box");
		const input = box.createEl("textarea", { cls: "st-comment-input st-reply-input", attr: { rows: "1", placeholder: "Reply", "aria-label": "Reply" } });
		const fit = () => {
			input.setCssStyles({ height: "auto" });
			input.setCssStyles({ height: input.scrollHeight + "px" });
			box.toggleClass("has-text", !!input.value.trim());
		};
		// Half-written replies survive the margin being redrawn.
		input.value = this.replyDrafts.get(note.id) ?? "";
		if (input.value) window.requestAnimationFrame(fit);
		box.toggleClass("has-text", !!input.value.trim());
		input.addEventListener("input", () => {
			this.replyDrafts.set(note.id, input.value);
			fit();
			this.queueLayout();
		});
		input.addEventListener("focus", () => {
			if (this.activeNote !== note.id) this.setActiveNote(note.id);
		});
		const suggest = new LinkSuggest(this.app, input, box, () => this.file?.path ?? "");
		const send = () => {
			const text = input.value.trim();
			if (!text) return;
			this.replyDrafts.delete(note.id);
			this.activeNote = note.id;
			this.mutate(() => note.replies.push({ id: uid(), text, author: this.plugin.settings.authorName, created: Date.now() }));
		};
		const cancel = () => {
			this.replyDrafts.delete(note.id);
			input.value = "";
			fit();
			input.blur();
			this.queueLayout();
		};
		this.commentButtons(box, "Reply", send, cancel, suggest);
		this.commentKeys(input, send, cancel);
	}

	private commentButtons(card: HTMLElement, label: string, ok: () => void, cancel: () => void, suggest?: LinkSuggest) {
		const row = card.createDiv("st-comment-buttons");
		if (suggest) {
			const link = row.createEl("button", { cls: "st-comment-link-btn", attr: { "aria-label": "Link to a note ([[)" } });
			setIcon(link, "link");
			link.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor where it is
			link.addEventListener("click", () => suggest.begin());
		}
		row.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
		row.createEl("button", { cls: "mod-cta", text: label }).addEventListener("click", ok);
	}

	private commentKeys(input: HTMLTextAreaElement, ok: () => void, cancel: () => void) {
		input.addEventListener("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				ok();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		});
	}

	private formatDate(ts: number): string {
		const d = new Date(ts);
		const sameDay = d.toDateString() === new Date().toDateString();
		return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
	}

	private setActiveNote(id: string | null) {
		this.activeNote = id;
		if (!this.marginEl) return;
		this.marginEl.querySelectorAll<HTMLElement>(".st-comment[data-note]").forEach((c) => c.toggleClass("is-active", c.dataset.note === id));
		this.repaintComments();
		this.layoutMargin();
	}

	private queueLayout() {
		if (this.layoutQueued) return;
		this.layoutQueued = true;
		window.requestAnimationFrame(() => {
			this.layoutQueued = false;
			this.layoutMargin();
		});
	}

	/**
	 * Places each comment card level with the item it's attached to, pushing cards down
	 * so they never overlap. The active card gets its ideal spot and the cards above it
	 * move up to make room, as in Google Docs.
	 */
	private layoutMargin() {
		const margin = this.marginEl;
		if (!margin || !this.scriptEl) return;
		const layer = margin.querySelector<HTMLElement>(".st-margin-layer");
		if (!layer) return;
		const base = layer.getBoundingClientRect().top;
		const cards = Array.from(layer.querySelectorAll<HTMLElement>("[data-anchor]"));
		const anchors = new Map<string, number>();
		const placed = cards
			.map((card, order) => {
				const id = card.dataset.anchor!;
				const start = card.dataset.start;
				const key = start === undefined ? id : id + "@" + start;
				if (!anchors.has(key)) {
					const el = this.scriptEl.querySelector<HTMLElement>(`.st-sheet [data-id="${id}"]`);
					// A comment on some of the words sits level with the line those words are on.
					const host = start === undefined ? null : el?.querySelector<HTMLElement>(".st-text");
					const ed = host ? this.editorOf.get(host) : undefined;
					const at = (ed ? ed.coordsAt(Number(start)) : host ? this.staticCoords(host, Number(start)) : null) ?? el?.getBoundingClientRect();
					anchors.set(key, at ? at.top - base : 0);
				}
				return { card, order, want: Math.max(0, anchors.get(key)!), top: 0, h: card.offsetHeight };
			})
			.sort((a, b) => a.want - b.want || a.order - b.order);

		let y = 0;
		for (const p of placed) {
			p.top = Math.max(p.want, y);
			y = p.top + p.h + CARD_GAP;
		}
		const k = placed.findIndex((p) => p.card.hasClass("is-active"));
		if (k >= 0 && placed[k].top > placed[k].want) {
			placed[k].top = placed[k].want;
			for (let i = k - 1; i >= 0; i--) placed[i].top = Math.min(placed[i].top, placed[i + 1].top - placed[i].h - CARD_GAP);
			const shift = Math.min(0, placed[0]?.top ?? 0);
			if (shift < 0) for (const p of placed) p.top -= shift;
			for (let i = 1; i < placed.length; i++) placed[i].top = Math.max(placed[i].top, placed[i - 1].top + placed[i - 1].h + CARD_GAP);
		}
		for (const p of placed) p.card.setCssStyles({ top: p.top + "px" });
		const bottom = placed.length ? placed[placed.length - 1].top + placed[placed.length - 1].h : 0;
		layer.setCssStyles({ height: bottom + "px" });

		this.scriptEl.querySelectorAll(".st-comment-anchor").forEach((el) => el.removeClass("st-comment-anchor"));
		// Word comments light up their words instead (see commentSpans).
		const active = placed[k]?.card.dataset.start === undefined ? placed[k]?.card.dataset.anchor : undefined;
		if (active) this.scriptEl.querySelector(`.st-sheet [data-id="${active}"]`)?.addClass("st-comment-anchor");
	}

	// ---------------------------------------------------------------- drag and drop

	private startDrag(e: DragEvent, payload: DragPayload, el: HTMLElement) {
		e.stopPropagation();
		this.drag = payload;
		e.dataTransfer?.setData(DRAG_MIME, "1");
		if (e.dataTransfer) e.dataTransfer.effectAllowed = payload.kind.startsWith("new") || payload.kind === "preset" ? "copy" : "move";
		window.requestAnimationFrame(() => el.addClass("is-dragging"));
		this.contentEl.addClass("is-drag-active");
	}

	private endDrag() {
		this.drag = null;
		this.clearDropHint();
		this.indicator = null;
		this.navLine = null;
		this.contentEl.removeClass("is-drag-active");
		this.contentEl.querySelectorAll(".is-dragging").forEach((el) => el.removeClass("is-dragging"));
		this.contentEl.querySelectorAll(".st-item[draggable], .st-pal-card[draggable]").forEach((el) => el.removeAttribute("draggable"));
	}

	private zoneItems(zone: HTMLElement): HTMLElement[] {
		return Array.from(zone.children).filter((c) => (c as HTMLElement).hasAttribute("data-drag-item")) as HTMLElement[];
	}

	private dropIndex(zone: HTMLElement, y: number): number {
		const items = this.zoneItems(zone);
		for (let i = 0; i < items.length; i++) {
			const r = items[i].getBoundingClientRect();
			if (y < r.top + r.height / 2) return i;
		}
		return items.length;
	}

	/** The element under/nearest the pointer among `els`, by vertical distance. */
	private nearest(els: HTMLElement[], y: number): HTMLElement | null {
		let best: HTMLElement | null = null;
		let bestDist = Infinity;
		for (const el of els) {
			const r = el.getBoundingClientRect();
			const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
			if (d < bestDist) {
				best = el;
				bestDist = d;
				if (d === 0) break;
			}
		}
		return best;
	}

	/**
	 * Works out where a drop at height `y` lands, wherever the pointer is: on a heading,
	 * a gap, the quick-add row, the title. Blocks go into the panel under (or nearest to)
	 * the pointer, panels into the nearest page, pages into the page list.
	 */
	private planScriptDrop(y: number): DropPlan | null {
		const p = this.drag;
		if (!p) return null;
		const sheet = this.scriptEl.querySelector<HTMLElement>(".st-sheet");
		if (!sheet) return null;
		const kind: ZoneKind = ACCEPTS.pages.includes(p.kind) ? "pages" : ACCEPTS.panels.includes(p.kind) ? "panels" : "blocks";

		if (kind === "pages") {
			const zone = sheet.querySelector<HTMLElement>(".st-pages");
			return zone ? { kind, container: null, index: this.dropIndex(zone, y), zone, target: null } : null;
		}
		const target = this.nearest(Array.from(sheet.querySelectorAll<HTMLElement>(kind === "panels" ? ".st-page" : ".st-panel")), y);
		const ref = target && findRef(this.doc, target.dataset.id!);
		if (!target || !ref) return null;
		if (kind === "panels" ? ref.page.locked : isLocked(ref)) return null;
		const container = kind === "panels" ? ref.page : ref.panel!;
		const zone = target.querySelector<HTMLElement>(kind === "panels" ? ":scope > .st-panels" : ":scope > .st-blocks");
		const count = kind === "panels" ? ref.page.panels.length : ref.panel!.blocks.length;
		return { kind, container, index: zone ? this.dropIndex(zone, y) : count, zone, target };
	}

	private planPaletteDrop(y: number): { sec: PaletteSection; index: number; zone: HTMLElement | null; target: HTMLElement } | null {
		const p = this.drag;
		if (!p || !(p.kind === "new-block" || p.kind === "preset" || p.kind === "block")) return null;
		const target = this.nearest(Array.from(this.paletteEl.querySelectorAll<HTMLElement>(".st-pal-section")), y);
		const sec = target && this.plugin.settings.paletteSections.find((s) => s.id === target.dataset.section);
		if (!target || !sec) return null;
		const zone = target.querySelector<HTMLElement>(":scope > .st-pal-items");
		return { sec, index: zone ? this.dropIndex(zone, y) : sec.items.length, zone, target };
	}

	private wireScriptDrop(el: HTMLElement) {
		el.addEventListener("dragover", (e) => {
			if (!this.drag) return;
			this.autoScroll(e.clientY);
			const plan = this.planScriptDrop(e.clientY);
			if (!plan) return this.clearDropHint(); // no preventDefault: the cursor shows "not allowed"
			e.preventDefault();
			this.setDropEffect(e);
			this.showDropHint(plan.zone, plan.index, plan.kind, plan.target);
			// Dragging a page in the script: mirror the spot in the pages list too.
			if (plan.kind === "pages") this.showNavLine(plan.index, true);
			else this.navLine?.remove();
		});
		el.addEventListener("drop", (e) => {
			if (!this.drag) return;
			e.preventDefault();
			const plan = this.planScriptDrop(e.clientY);
			const payload = this.drag;
			this.endDrag();
			if (plan) this.performDrop(plan.kind, plan.container, plan.index, payload);
		});
	}

	private wirePaletteDrop(el: HTMLElement) {
		el.addEventListener("dragover", (e) => {
			if (!this.drag) return;
			const plan = this.planPaletteDrop(e.clientY);
			if (!plan) return this.clearDropHint();
			e.preventDefault();
			this.setDropEffect(e);
			this.showDropHint(plan.zone, plan.index, "palette", plan.target);
		});
		el.addEventListener("drop", (e) => {
			if (!this.drag) return;
			e.preventDefault();
			const plan = this.planPaletteDrop(e.clientY);
			const payload = this.drag;
			this.endDrag();
			if (plan) this.performPaletteDrop(plan.sec, plan.index, payload);
		});
	}

	private setDropEffect(e: DragEvent) {
		if (e.dataTransfer) e.dataTransfer.dropEffect = this.drag!.kind.startsWith("new") || this.drag!.kind === "preset" ? "copy" : "move";
	}

	/** Shows the insertion line in `zone` at `index`, or highlights a collapsed target. */
	private showDropHint(zone: HTMLElement | null, index: number, kind: string, target: HTMLElement | null) {
		this.contentEl.querySelectorAll(".st-drop-target").forEach((t) => t !== target && t.removeClass("st-drop-target"));
		if (!zone) {
			this.indicator?.remove();
			target?.addClass("st-drop-target");
			return;
		}
		target?.removeClass("st-drop-target");
		const items = this.zoneItems(zone);
		const ind = (this.indicator ??= createDiv("st-drop-indicator"));
		ind.dataset.kind = kind;
		if (items[index]) {
			if (ind.nextElementSibling !== items[index]) items[index].before(ind);
		} else if (items.length) {
			if (ind.previousElementSibling !== items[items.length - 1] || ind.parentElement !== zone) items[items.length - 1].after(ind);
		} else if (ind.parentElement !== zone) {
			zone.prepend(ind);
		}
	}

	/**
	 * Shows where a dragged page will land in the pages list: a line in the gap before page
	 * `index`, labelled with the page number it will become. `reveal` scrolls the gap into view.
	 */
	private showNavLine(index: number, reveal = false) {
		const list = this.navEl?.querySelector<HTMLElement>(".st-nav-list");
		const p = this.drag;
		if (!list || !p) return;
		const items = this.zoneItems(list);
		const line = (this.navLine ??= createDiv({ cls: "st-nav-line", attr: { "aria-hidden": "true" } }));
		if (line.parentElement !== list) {
			line.empty();
			line.createSpan("st-nav-line-label");
			list.appendChild(line);
		}

		// Middle of the gap between the neighbouring items, in the list's scrolled coordinates.
		const prev = items[index - 1];
		const next = items[index];
		let top = 0;
		if (prev && next) top = (prev.offsetTop + prev.offsetHeight + next.offsetTop) / 2;
		else if (next) top = Math.max(next.offsetTop - 2, 1);
		else if (prev) top = prev.offsetTop + prev.offsetHeight + 2;
		line.setCssStyles({ top: `${Math.round(top)}px` });

		// The page number it ends up as; dropping a page right where it is changes nothing.
		const from = p.kind === "page" ? this.doc.pages.findIndex((pg) => pg.id === p.id) : -1;
		const noop = from >= 0 && (index === from || index === from + 1);
		const pos = from >= 0 && from < index ? index : index + 1;
		line.toggleClass("is-noop", noop);
		const label = line.querySelector<HTMLElement>(".st-nav-line-label");
		if (label) label.setText(noop ? "No change" : p.kind === "new-page" ? `New page ${pos}` : `Becomes page ${pos}`);

		if (reveal) {
			const pad = 24;
			if (top < list.scrollTop + pad) list.scrollTop = top - pad;
			else if (top > list.scrollTop + list.clientHeight - pad) list.scrollTop = top - list.clientHeight + pad;
		}
	}

	/** Scrolls the pages list when dragging near its top or bottom edge. */
	private autoScrollNav(list: HTMLElement, y: number) {
		const r = list.getBoundingClientRect();
		const edge = Math.min(SCROLL_EDGE, r.height / 4);
		if (y < r.top + edge) list.scrollTop -= Math.ceil((r.top + edge - y) / 3);
		else if (y > r.bottom - edge) list.scrollTop += Math.ceil((y - (r.bottom - edge)) / 3);
	}

	private clearDropHint() {
		this.indicator?.remove();
		this.navLine?.remove();
		this.contentEl.querySelectorAll(".st-drop-target").forEach((t) => t.removeClass("st-drop-target"));
	}

	/** Scrolls the script when dragging near its top or bottom edge, so far pages are reachable. */
	private autoScroll(y: number) {
		const r = this.scriptEl.getBoundingClientRect();
		if (y < r.top + SCROLL_EDGE) this.scriptEl.scrollTop -= Math.ceil((r.top + SCROLL_EDGE - y) / 3);
		else if (y > r.bottom - SCROLL_EDGE) this.scriptEl.scrollTop += Math.ceil((y - (r.bottom - SCROLL_EDGE)) / 3);
	}

	private performDrop(kind: ZoneKind, container: Page | Panel | null, index: number, payload: DragPayload) {
		const settings = this.plugin.settings;
		let focusId: string | null = null;

		this.mutate(() => {
			if (kind === "pages") {
				const list = this.doc.pages;
				if (payload.kind === "new-page") {
					const page = newPage(settings);
					list.splice(index, 0, page);
					focusId = page.id;
				} else if (payload.kind === "page") {
					this.moveWithin(list, payload.id, list, index);
				}
			} else if (kind === "panels") {
				const page = container as Page;
				page.collapsed = false;
				if (payload.kind === "new-panel") {
					const panel = newPanel(settings);
					page.panels.splice(index, 0, panel);
					focusId = panel.blocks[0]?.id ?? null;
				} else if (payload.kind === "panel") {
					const src = findRef(this.doc, payload.id);
					if (src) this.moveWithin(src.page.panels, payload.id, page.panels, index);
				}
			} else {
				const panel = container as Panel;
				panel.collapsed = false;
				let block: Block | null = null;
				if (payload.kind === "new-block") block = newBlock(findType(settings, payload.typeId));
				else if (payload.kind === "preset") {
					const preset = settings.presets.find((p) => p.id === payload.presetId);
					if (preset) block = blockFromPreset(preset);
				} else if (payload.kind === "block") {
					const src = findRef(this.doc, payload.id);
					if (src?.panel) this.moveWithin(src.panel.blocks, payload.id, panel.blocks, index);
				}
				if (block) {
					panel.blocks.splice(index, 0, block);
					focusId = block.id;
				}
			}
		});
		if (focusId) {
			this.focusAfterRender = focusId;
			this.jumpTo(focusId);
		} else if ("id" in payload) {
			this.jumpTo(payload.id, true);
		}
	}

	private moveWithin<T extends { id: string }>(from: T[], id: string, to: T[], index: number) {
		const srcIndex = from.findIndex((x) => x.id === id);
		if (srcIndex < 0) return;
		if (from === to && srcIndex < index) index--;
		const [item] = from.splice(srcIndex, 1);
		to.splice(index, 0, item);
	}

	// ---------------------------------------------------------------- pinned & revisions panel

	private renderSide() {
		const el = this.sideEl;
		const refs = [...walk(this.doc)];
		const pinned = refs.filter((r) => r.item.pinned);
		const revisions = refs.filter((r) => r.item.revision);

		const tabs = el.createDiv("st-tabs");
		const tab = (id: SideTab, label: string, count: number) => {
			const t = tabs.createEl("button", { cls: "st-tab" + (this.sideTab === id ? " is-active" : ""), text: label });
			if (count) t.createSpan({ cls: "st-tab-count", text: String(count) });
			t.addEventListener("click", () => {
				this.sideTab = id;
				this.renderAll();
			});
		};
		tab("pinned", "Pinned", pinned.length);
		tab("revisions", "Revise", revisions.length);

		const body = el.createDiv("st-side-body");
		if (this.sideTab === "pinned") this.renderRefList(body, pinned, "Right-click a page, panel or block and choose Pin to keep it one click away.", "pin");
		else this.renderRefList(body, revisions, "Nothing is marked for revision.", "flag");
	}

	private snippet(ref: ItemRef): string {
		if (ref.block) return ref.block.text.trim() || "(empty)";
		if (ref.panel) return ref.panel.blocks.find((b) => b.text.trim())?.text.trim() ?? "(empty panel)";
		return `${ref.page.panels.length} panel${ref.page.panels.length === 1 ? "" : "s"}`;
	}

	private renderRefList(body: HTMLElement, refs: ItemRef[], empty: string, flag: "pin" | "flag") {
		if (!refs.length) {
			body.createDiv({ cls: "st-side-empty", text: empty });
			return;
		}
		for (const ref of refs) {
			const card = body.createDiv("st-card is-clickable");
			const top = card.createDiv("st-card-top");
			top.createSpan({ cls: "st-card-loc", text: describeRef(ref, this.plugin.settings) });
			this.iconBtn(top, "x", flag === "pin" ? "Unpin" : "Clear revision mark", () =>
				this.mutate(() => (flag === "pin" ? (ref.item.pinned = false) : (ref.item.revision = false)))
			);
			card.createDiv({ cls: "st-card-text", text: this.snippet(ref).slice(0, 200) });
			card.addEventListener("click", () => this.jumpTo(ref.item.id));
		}
		if (flag === "flag") {
			const clear = body.createEl("button", { cls: "st-side-action", text: "Clear all revision marks" });
			clear.addEventListener("click", () => {
				this.mutate(() => refs.forEach((r) => (r.item.revision = false)));
				this.undoNotice(`Cleared ${refs.length} revision mark${refs.length === 1 ? "" : "s"}.`);
			});
		}
	}
}
