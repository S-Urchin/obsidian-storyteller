/*
 * Inline formatting, shared by the editor, Read mode and the Word export so they always agree.
 *
 * Text is saved with markdown-like markers:
 *
 *   **bold**   *italic*   ***bold italic***   __underline__   ==highlight==
 *   =g=green=g=   =b=blue=b=   =p=pink=p=   =o=orange=o=      (plain == is yellow)
 *   \*  \_  \=  \\      a character that would otherwise read as a marker
 *
 * Markers are switches: each one turns its style on or off, so styles can nest and overlap
 * (**bold =o=and orange=o=**). A marker that isn't switched back off on the same line is
 * ordinary text, so older scripts with a stray * still read as they did.
 *
 * The editor never shows markers. It edits a Rich value, the plain text with a style for
 * each character, and writes the markers back with serialize().
 */

import { HighlightColor } from "./types";

export interface Style {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	highlight: HighlightColor | null;
}

export const PLAIN: Style = { bold: false, italic: false, underline: false, highlight: null };

export const sameStyle = (a: Style, b: Style) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.highlight === b.highlight;

export interface Segment {
	text: string;
	/** A formatting marker or escape backslash: hidden in the editor, dropped from the export. */
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

/** Characters that are escaped with a backslash when they're meant literally. */
const SPECIAL = "*_=\\";

// Longest first, so "=g=" isn't read as "==" followed by "g=".
const HIGHLIGHT_BY_LENGTH = (Object.entries(HIGHLIGHT_MARKERS) as [HighlightColor, string][]).sort((a, b) => b[1].length - a[1].length);

interface Token {
	at: number;
	len: number;
	kind: "star" | "under" | "highlight" | "escape";
	color?: HighlightColor;
	literal?: boolean;
}

/** Finds the markers in text[from, to), which holds no line breaks. */
function tokenize(text: string, from: number, to: number): Token[] {
	const out: Token[] = [];
	let i = from;
	while (i < to) {
		const c = text[i];
		if (c === "\\" && i + 1 < to && SPECIAL.includes(text[i + 1])) {
			out.push({ at: i, len: 1, kind: "escape" });
			i += 2;
		} else if (c === "*" || c === "_") {
			let j = i;
			while (j < to && text[j] === c) j++;
			const n = j - i;
			// Runs that can't be a marker (*****, a lone _) stay text.
			if (c === "*" && n <= 3) out.push({ at: i, len: n, kind: "star" });
			else if (c === "_" && n === 2) out.push({ at: i, len: 2, kind: "under" });
			i = j;
		} else if (c === "=") {
			const hit = HIGHLIGHT_BY_LENGTH.find(([, m]) => i + m.length <= to && text.startsWith(m, i));
			if (hit) {
				out.push({ at: i, len: hit[1].length, kind: "highlight", color: hit[0] });
				i += hit[1].length;
			} else i++;
		} else i++;
	}
	return out;
}

/** Marks markers that are never switched off again on their line as plain text. */
function settle(tokens: Token[]) {
	for (let pass = 0; pass <= tokens.length; pass++) {
		let bold = -1;
		let italic = -1;
		let underline = -1;
		let highlight = -1;
		for (let k = 0; k < tokens.length; k++) {
			const t = tokens[k];
			if (t.literal) continue;
			if (t.kind === "star") {
				if (t.len !== 2) italic = italic < 0 ? k : -1;
				if (t.len !== 1) bold = bold < 0 ? k : -1;
			} else if (t.kind === "under") underline = underline < 0 ? k : -1;
			else if (t.kind === "highlight") {
				if (highlight < 0) highlight = k;
				else if (tokens[highlight].color === t.color) highlight = -1;
				else t.literal = true; // a different colour while one is open: not a marker
			}
		}
		const open = Math.max(bold, italic, underline, highlight);
		if (open < 0) return;
		tokens[open].literal = true;
	}
}

/** Splits raw text into styled text and markers; the pieces join back into exactly the input. */
export function parseInline(text: string): Segment[] {
	const out: Segment[] = [];
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = text.length;
		const tokens = tokenize(text, lineStart, lineEnd);
		settle(tokens);
		const style: Style = { ...PLAIN };
		let pos = lineStart;
		const pushText = (to: number) => {
			if (to <= pos) return;
			const seg: Segment = { text: text.slice(pos, to), marker: false };
			if (style.bold) seg.bold = true;
			if (style.italic) seg.italic = true;
			if (style.underline) seg.underline = true;
			if (style.highlight) seg.highlight = style.highlight;
			out.push(seg);
			pos = to;
		};
		for (const t of tokens) {
			if (t.literal) continue;
			pushText(t.at);
			out.push({ text: text.slice(t.at, t.at + t.len), marker: true });
			pos = t.at + t.len;
			if (t.kind === "star") {
				if (t.len !== 2) style.italic = !style.italic;
				if (t.len !== 1) style.bold = !style.bold;
			} else if (t.kind === "under") style.underline = !style.underline;
			else if (t.kind === "highlight") style.highlight = style.highlight ? null : t.color!;
		}
		pushText(lineEnd);
		if (lineEnd >= text.length) break;
		out.push({ text: "\n", marker: false });
		lineStart = lineEnd + 1;
	}
	return out;
}

/** The text as it reads, with markers dropped. */
export function plainText(text: string): string {
	return parseInline(text)
		.filter((s) => !s.marker)
		.map((s) => s.text)
		.join("");
}

// ---------------------------------------------------------------- the editor's model

/** Plain text with one style per character, plus where each character sits in the raw text. */
export interface Rich {
	text: string;
	styles: Style[];
	/** Raw offset of each character (after any escape backslash); at[text.length] is the raw length. */
	at: number[];
}

export function toRich(raw: string): Rich {
	let text = "";
	const styles: Style[] = [];
	const at: number[] = [];
	let pos = 0;
	for (const seg of parseInline(raw)) {
		if (!seg.marker) {
			const style: Style = { bold: !!seg.bold, italic: !!seg.italic, underline: !!seg.underline, highlight: seg.highlight ?? null };
			for (let k = 0; k < seg.text.length; k++) {
				text += seg.text[k];
				styles.push(style);
				at.push(pos + k);
			}
		}
		pos += seg.text.length;
	}
	at.push(raw.length);
	return { text, styles, at };
}

/** Writes markers back, switching styles at the fewest places; every line ends with all styles off. */
export function serialize(text: string, styles: Style[]): string {
	let out = "";
	let cur: Style = PLAIN;
	const switchTo = (to: Style) => {
		if (sameStyle(cur, to)) return;
		if (cur.highlight && cur.highlight !== to.highlight) out += HIGHLIGHT_MARKERS[cur.highlight];
		const b = cur.bold !== to.bold;
		const i = cur.italic !== to.italic;
		if (b || i) out += b && i ? "***" : b ? "**" : "*";
		if (cur.underline !== to.underline) out += "__";
		if (to.highlight && cur.highlight !== to.highlight) out += HIGHLIGHT_MARKERS[to.highlight];
		cur = to;
	};
	for (let k = 0; k < text.length; k++) {
		const ch = text[k];
		if (ch === "\n") {
			switchTo(PLAIN);
			out += ch;
			continue;
		}
		switchTo(styles[k] ?? PLAIN);
		out += SPECIAL.includes(ch) ? "\\" + ch : ch;
	}
	switchTo(PLAIN);
	return out;
}

/** How many characters of plain text come before a raw offset. */
export function rawToPlain(rich: Rich, raw: number): number {
	let lo = 0;
	let hi = rich.text.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rich.at[mid] < raw) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Raw offset where plain character `k` starts (before its escape backslash, if any). */
export function charStart(raw: string, rich: Rich, k: number): number {
	if (k >= rich.text.length) return raw.length;
	const a = rich.at[k];
	return a > 0 && raw[a - 1] === "\\" && SPECIAL.includes(raw[a]) ? a - 1 : a;
}

/** Raw offset just after plain character `k - 1`, inside its styling: where typing carries the style on. */
export function caretAfter(rich: Rich, k: number): number {
	return k > 0 ? rich.at[k - 1] + 1 : rich.at[0];
}

/** What a stretch of plain text has in common: bold only if all of it is bold, and so on. */
export function commonStyle(styles: Style[], from: number, to: number): Style {
	if (from >= to) return styles[Math.max(0, from - 1)] ?? PLAIN;
	const out: Style = { bold: true, italic: true, underline: true, highlight: styles[from].highlight };
	for (let k = from; k < to; k++) {
		const s = styles[k];
		out.bold &&= s.bold;
		out.italic &&= s.italic;
		out.underline &&= s.underline;
		if (s.highlight !== out.highlight) out.highlight = null;
	}
	return out;
}

// ---------------------------------------------------------------- minimal edits

export interface Change {
	from: number;
	to: number;
	insert: string;
}

/**
 * The edits that turn `a` into `b`, as small as possible (Myers' diff on the part that differs),
 * so positions in unchanged text, like comment anchors, map through cleanly. Positions refer to `a`.
 */
export function diffText(a: string, b: string): Change[] {
	if (a === b) return [];
	let p = 0;
	const max = Math.min(a.length, b.length);
	while (p < max && a[p] === b[p]) p++;
	let s = 0;
	while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const A = a.slice(p, a.length - s);
	const B = b.slice(p, b.length - s);
	const N = A.length;
	const M = B.length;
	const whole = [{ from: p, to: p + N, insert: B }];
	if (!N || !M || N * M > 4_000_000) return whole;

	const LIMIT = 400;
	const off = N + M;
	const v = new Int32Array(2 * off + 2);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= Math.min(N + M, LIMIT); d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < N && y < M && A[x] === B[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= N && y >= M) {
				found = true;
				break;
			}
		}
		if (found) break;
	}
	if (!found) return whole;

	// Walk back through the snapshots to recover the edit script.
	const ops: Change[] = [];
	let x = N;
	let y = M;
	for (let d = trace.length - 1; d > 0; d--) {
		const vd = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
		const prevX = vd[off + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
		}
		if (x === prevX) ops.push({ from: p + x, to: p + x, insert: B[prevY] }); // insertion of B[prevY]
		else ops.push({ from: p + prevX, to: p + prevX + 1, insert: "" }); // deletion of A[prevX]
		x = prevX;
		y = prevY;
	}
	ops.reverse();
	// Merge neighbouring single-character steps into runs.
	const merged: Change[] = [];
	for (const op of ops) {
		const last = merged[merged.length - 1];
		if (last && op.from === last.to) {
			last.to = op.to;
			last.insert += op.insert;
		} else if (last && op.from === last.from && op.to === op.from && last.to === last.from) {
			last.insert += op.insert;
		} else merged.push({ ...op });
	}
	return merged;
}

/** Splits raw text into pieces with their offsets, cut wherever a span starts or ends (for comments). */
export function cutSegments(text: string, spans: { start: number; end: number }[]): { seg: Segment; from: number; to: number }[] {
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
