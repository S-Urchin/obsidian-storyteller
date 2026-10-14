import {
	BalloonScope,
	Block,
	BlockPreset,
	BlockType,
	ComicDoc,
	ItemMeta,
	ItemRef,
	Page,
	PageNumberStyle,
	Panel,
	StorytellerSettings,
	DEFAULT_FREE_FORMAT,
	FreeFormat,
	NoteReply,
	SideNote,
} from "./types";

export function uid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function meta(): ItemMeta {
	return { id: uid(), locked: false, revision: false, pinned: false, notes: [] };
}

export function findType(settings: StorytellerSettings, typeId: string): BlockType {
	return (
		settings.blockTypes.find((t) => t.id === typeId) ?? {
			id: typeId,
			name: typeId || "Unknown",
			color: "#888888",
			style: "description",
			numbered: false,
			defaultSpeaker: "",
			fixedSpeaker: false,
			defaultText: "",
		}
	);
}

export function newBlock(type: BlockType): Block {
	return { ...meta(), typeId: type.id, speaker: type.defaultSpeaker, modifier: "", text: type.defaultText };
}

export function blockFromPreset(preset: BlockPreset): Block {
	return { ...meta(), typeId: preset.typeId, speaker: preset.speaker, modifier: preset.modifier, text: preset.text };
}

export function newPanel(settings: StorytellerSettings): Panel {
	const blocks = settings.newPanelBlocks
		.map((id) => settings.blockTypes.find((t) => t.id === id))
		.filter((t): t is BlockType => !!t)
		.map(newBlock);
	return { ...meta(), collapsed: false, blocks };
}

export function newPage(settings: StorytellerSettings): Page {
	const panels: Panel[] = [];
	for (let i = 0; i < Math.max(0, settings.newPagePanels); i++) panels.push(newPanel(settings));
	return { ...meta(), collapsed: false, panels };
}

export function defaultByline(settings: StorytellerSettings): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${String(d.getFullYear()).slice(2)} - by ${settings.authorName}`;
}

export function newDoc(settings: StorytellerSettings, title: string): ComicDoc {
	return { format: "storyteller-comic", version: 1, title, byline: defaultByline(settings), pages: [newPage(settings)] };
}

type Nested = ItemMeta & { panels?: Nested[]; blocks?: Nested[] };

/** Deep-copies an item and gives it (and every descendant) fresh ids. */
export function cloneWithNewIds<T extends ItemMeta>(item: T): T {
	const copy = JSON.parse(JSON.stringify(item)) as T;
	const reId = (o: Nested) => {
		o.id = uid();
		o.locked = false;
		o.notes = [];
		o.panels?.forEach(reId);
		o.blocks?.forEach(reId);
	};
	reId(copy);
	return copy;
}

// ---------------------------------------------------------------- loading files safely

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

function loadReply(v: unknown): NoteReply {
	const o = obj(v);
	return {
		id: str(o.id, uid()),
		text: str(o.text, ""),
		author: str(o.author, ""),
		created: typeof o.created === "number" ? o.created : Date.now(),
	};
}

function loadNote(v: unknown): SideNote {
	const o = obj(v);
	const note: SideNote = {
		id: str(o.id, uid()),
		text: str(o.text, ""),
		author: str(o.author, ""),
		created: typeof o.created === "number" ? o.created : Date.now(),
		resolved: !!o.resolved,
		replies: list(o.replies).map(loadReply),
	};
	const r = obj(o.range);
	const start = typeof r.start === "number" ? Math.max(0, Math.floor(r.start)) : -1;
	const end = typeof r.end === "number" ? Math.floor(r.end) : -1;
	if (start >= 0 && end >= start) note.range = { start, end };
	return note;
}

function loadMeta(o: Loose): ItemMeta {
	return {
		id: str(o.id, uid()),
		locked: !!o.locked,
		revision: !!o.revision,
		pinned: !!o.pinned,
		notes: list(o.notes).map(loadNote),
	};
}

function loadFormat(v: unknown): FreeFormat | undefined {
	if (v === undefined) return undefined;
	const o = obj(v);
	return {
		align: oneOf(o.align, ["left", "center", "right"] as const, DEFAULT_FREE_FORMAT.align),
		indent: !!o.indent,
		size: oneOf(o.size, ["small", "normal", "large"] as const, DEFAULT_FREE_FORMAT.size),
		box: !!o.box,
	};
}

function loadBlock(v: unknown): Block {
	const o = obj(v);
	const block: Block = {
		...loadMeta(o),
		typeId: str(o.typeId, "description"),
		speaker: str(o.speaker, ""),
		modifier: str(o.modifier, ""),
		text: str(o.text, ""),
	};
	const format = loadFormat(o.format);
	if (format) block.format = format;
	return block;
}

function loadPanel(v: unknown): Panel {
	const o = obj(v);
	return { ...loadMeta(o), collapsed: !!o.collapsed, blocks: list(o.blocks).map(loadBlock) };
}

function loadPage(v: unknown): Page {
	const o = obj(v);
	return { ...loadMeta(o), collapsed: !!o.collapsed, panels: list(o.panels).map(loadPanel) };
}

/** Builds a clean document from parsed JSON, filling in anything missing so older or hand-edited files still load. */
export function normalizeDoc(raw: unknown, fallbackTitle: string): ComicDoc {
	const o = obj(raw);
	return {
		format: "storyteller-comic",
		version: 1,
		title: str(o.title, fallbackTitle),
		byline: str(o.byline, ""),
		pages: list(o.pages).map(loadPage),
	};
}

/** Walks every page, panel and block in reading order. */
export function* walk(doc: ComicDoc): Generator<ItemRef> {
	for (let pi = 0; pi < doc.pages.length; pi++) {
		const page = doc.pages[pi];
		yield { kind: "page", item: page, page, pageIndex: pi };
		for (let ni = 0; ni < page.panels.length; ni++) {
			const panel = page.panels[ni];
			yield { kind: "panel", item: panel, page, panel, pageIndex: pi, panelIndex: ni };
			for (let bi = 0; bi < panel.blocks.length; bi++) {
				const block = panel.blocks[bi];
				yield { kind: "block", item: block, page, panel, block, pageIndex: pi, panelIndex: ni, blockIndex: bi };
			}
		}
	}
}

export function findRef(doc: ComicDoc, id: string): ItemRef | null {
	for (const ref of walk(doc)) if (ref.item.id === id) return ref;
	return null;
}

/** An item is effectively locked if it, or any container above it, is locked. */
export function isLocked(ref: ItemRef): boolean {
	if (ref.page.locked) return true;
	if (ref.kind !== "page" && ref.panel?.locked) return true;
	return ref.item.locked;
}

const ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];

export function numberToWords(n: number): string {
	if (n < 20) return ONES[n];
	if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
	if (n < 1000) return ONES[Math.floor(n / 100)] + " HUNDRED" + (n % 100 ? " " + numberToWords(n % 100) : "");
	return String(n);
}

export function pageLabel(index: number, style: PageNumberStyle): string {
	return "PAGE " + (style === "words" ? numberToWords(index + 1) : String(index + 1));
}

export function panelLabel(index: number): string {
	return "Panel " + (index + 1) + ":";
}

/** Balloon numbers per block id, recomputed from scratch so they always follow the current order. */
export function balloonNumbers(doc: ComicDoc, settings: StorytellerSettings, scope: BalloonScope): Map<string, number> {
	const out = new Map<string, number>();
	if (scope === "off") return out;
	for (const page of doc.pages) {
		let n = 0;
		for (const panel of page.panels) {
			if (scope === "panel") n = 0;
			for (const block of panel.blocks) {
				const type = findType(settings, block.typeId);
				if (type.style === "lettering" && type.numbered) out.set(block.id, ++n);
			}
		}
	}
	return out;
}

export function wordCount(text: string): number {
	const m = text.trim().match(/\S+/g);
	return m ? m.length : 0;
}

/** Words of lettering in a panel — handy for spotting overcrowded panels. */
export function panelLetteringWords(panel: Panel, settings: StorytellerSettings): number {
	let n = 0;
	for (const b of panel.blocks) if (findType(settings, b.typeId).style === "lettering") n += wordCount(b.text);
	return n;
}

/** All speaker names used in the document, most frequent first, for autocomplete. */
export function collectSpeakers(doc: ComicDoc): string[] {
	const counts = new Map<string, number>();
	for (const ref of walk(doc)) {
		if (ref.kind !== "block") continue;
		const s = (ref.item as Block).speaker.trim().toUpperCase();
		if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/** "Page 3 › Panel 2 › Dialogue" style location string. */
export function describeRef(ref: ItemRef, settings: StorytellerSettings): string {
	const parts = [`Page ${ref.pageIndex + 1}`];
	if (ref.panelIndex !== undefined) parts.push(`Panel ${ref.panelIndex + 1}`);
	if (ref.block) {
		const type = findType(settings, ref.block.typeId);
		const who = type.style === "lettering" && ref.block.speaker ? ` (${ref.block.speaker})` : "";
		parts.push(type.name + who);
	}
	return parts.join(" › ");
}

/**
 * Keeps word comments on the same words while their block's text is edited.
 * The edit is taken to be the span between the common start and end of the two texts.
 * Typing just before or after the commented words stays outside them; typing inside
 * grows the range; deleting the words leaves the comment at the spot they were.
 * `caret` (the cursor after the edit) settles where typing went when the text alone can't
 * tell, e.g. a "y" typed inside "Hey" versus after it.
 * Returns whether any note has a range (so the caller knows to repaint).
 */
export function remapNoteRanges(notes: SideNote[], before: string, after: string, caret?: number): boolean {
	const ranged = notes.filter((n) => n.range);
	if (!ranged.length || before === after) return ranged.length > 0;
	const max = Math.min(before.length, after.length);
	let p = 0;
	while (p < max && before[p] === after[p]) p++;
	if (caret !== undefined) p = Math.max(0, Math.min(p, caret - Math.max(0, after.length - before.length)));
	let s = 0;
	while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
	const oldEnd = before.length - s;
	const newEnd = after.length - s;
	const delta = newEnd - oldEnd;
	for (const n of ranged) {
		const r = n.range!;
		const start = r.start < p ? r.start : r.start >= oldEnd ? r.start + delta : p;
		const end = r.end <= p ? r.end : r.end >= oldEnd ? r.end + delta : newEnd;
		r.start = Math.min(start, after.length);
		r.end = Math.max(r.start, Math.min(end, after.length));
	}
	return true;
}

/** A freestyle block's layout, filled in with defaults. */
export function freeFormat(block: Block): FreeFormat {
	return { ...DEFAULT_FREE_FORMAT, ...(block.format ?? {}) };
}
