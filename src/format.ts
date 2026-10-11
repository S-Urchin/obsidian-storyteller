/*
 * Inline formatting, shared by the editor preview and the Word export so they always agree.
 *
 *   ***bold italic***   **bold**   *italic*   __underline__   ==highlight==
 *
 * Markers don't nest (except *** for bold italic) and don't span lines, which keeps
 * the rules predictable while typing.
 */

export interface Segment {
	text: string;
	/** A formatting marker (**, ==, …): faded in the editor, dropped from the export. */
	marker: boolean;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	highlight?: boolean;
}

const TOKEN = /(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|__[^_\n]+?__|==[^=\n]+?==)/g;

export function parseInline(text: string): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	TOKEN.lastIndex = 0;
	while ((m = TOKEN.exec(text))) {
		if (m.index > last) out.push({ text: text.slice(last, m.index), marker: false });
		const tok = m[0];
		const n = tok.startsWith("***") ? 3 : tok.startsWith("**") || tok.startsWith("__") || tok.startsWith("==") ? 2 : 1;
		const mark = tok.slice(0, n);
		const style: Partial<Segment> =
			mark === "***" ? { bold: true, italic: true }
			: mark === "**" ? { bold: true }
			: mark === "*" ? { italic: true }
			: mark === "__" ? { underline: true }
			: { highlight: true };
		out.push({ text: mark, marker: true }, { text: tok.slice(n, -n), marker: false, ...style }, { text: mark, marker: true });
		last = m.index + tok.length;
	}
	if (last < text.length) out.push({ text: text.slice(last), marker: false });
	return out;
}

/** Renders text as styled spans (markers included, faded) for the editor's live preview. */
export function renderInline(parent: HTMLElement, text: string) {
	parent.empty();
	for (const seg of parseInline(text)) {
		if (!seg.marker && !seg.bold && !seg.italic && !seg.underline && !seg.highlight) {
			parent.appendText(seg.text);
			continue;
		}
		const span = parent.createSpan({ text: seg.text });
		if (seg.marker) span.addClass("st-md");
		if (seg.bold) span.addClass("st-b");
		if (seg.italic) span.addClass("st-i");
		if (seg.underline) span.addClass("st-u");
		if (seg.highlight) span.addClass("st-mark");
	}
	// A trailing newline needs content after it, or the preview is a line short of the text box.
	if (text.endsWith("\n") || !text) parent.appendText("​");
}

export type Marker = "**" | "*" | "__" | "==";

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
