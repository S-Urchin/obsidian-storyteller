import assert from "node:assert/strict";
import { commonStyle, diffText, parseInline, plainText, PLAIN, rawToPlain, serialize, Style, toRich } from "../src/format";
import { HighlightColor } from "../src/types";
import { test, rng } from "./harness";

const BS = "\\"; // one backslash
const NL = "\n";

/** "[b+i]text|plain" — each styled piece of the text, markers dropped. */
const styled = (raw: string) =>
	parseInline(raw)
		.filter((s) => !s.marker)
		.map((s) => {
			const f = [s.bold && "b", s.italic && "i", s.underline && "u", s.highlight && "h:" + s.highlight].filter(Boolean).join("+");
			return f ? `[${f}]${s.text}` : s.text;
		})
		.join("|");

test("old syntax reads as before", () => {
	assert.equal(styled("**bold** and *it*"), "[b]bold| and |[i]it");
	assert.equal(styled("***both***"), "[b+i]both");
	assert.equal(styled("__under__ ==yellow== =g=green=g= =o=orange=o="), "[u]under| |[h:yellow]yellow| |[h:green]green| |[h:orange]orange");
});

test("stray markers stay text", () => {
	assert.equal(plainText("5 * 3 = 15"), "5 * 3 = 15");
	assert.equal(plainText("a == b"), "a == b");
	assert.equal(plainText("snake_case and __init"), "snake_case and __init");
	assert.equal(plainText("x** y"), "x** y");
	assert.equal(styled("*a *b*"), "[i]a |b*");
	assert.equal(plainText("****"), "****");
});

test("markers don't span lines", () => {
	assert.equal(styled("**a" + NL + "b**"), "**a|" + NL + "|b**");
});

test("styles nest and overlap", () => {
	assert.equal(styled("**bold =o=and orange=o=**"), "[b]bold |[b+h:orange]and orange");
	assert.equal(styled("**a *b* c**"), "[b]a |[b+i]b|[b] c");
	assert.equal(styled("=o=**Light up!**=o="), "[b+h:orange]Light up!");
});

test("escapes are literal and hidden", () => {
	const raw = `5 ${BS}* 3 ${BS}= 15 ${BS}_x${BS}_ ${BS}${BS}`;
	assert.equal(plainText(raw), `5 * 3 = 15 _x_ ${BS}`);
	assert.equal(styled(`**a${BS}*b**`), "[b]a|[b]*b");
	// A backslash before an ordinary letter is just a backslash.
	assert.equal(plainText(`a${BS}b`), `a${BS}b`);
});

test("segments always join back into the raw text", () => {
	const r = rng(1);
	const chars = ["a", "b", " ", "*", "_", "=", BS, NL, "g", "o"];
	for (let n = 0; n < 3000; n++) {
		let s = "";
		const len = r.int(0, 30);
		for (let i = 0; i < len; i++) s += r.pick(chars);
		assert.equal(
			parseInline(s)
				.map((x) => x.text)
				.join(""),
			s,
			JSON.stringify(s)
		);
	}
});

const COLORS: (HighlightColor | null)[] = [null, null, "yellow", "green", "blue", "pink", "orange"];
const randomStyle = (r: ReturnType<typeof rng>): Style => ({ bold: r.bit(), italic: r.bit(), underline: r.bit(), highlight: r.pick(COLORS) });

test("serialize → parse gives back the same text and styles", () => {
	const r = rng(2);
	const chars = ["a", "b", "g", " ", "o", "*", "_", "=", BS, NL];
	for (let n = 0; n < 5000; n++) {
		const len = r.int(0, 25);
		let text = "";
		const styles: Style[] = [];
		let cur = randomStyle(r);
		for (let i = 0; i < len; i++) {
			if (r.int(0, 3) === 0) cur = randomStyle(r);
			const ch = r.pick(chars);
			text += ch;
			styles.push(ch === NL ? PLAIN : cur);
		}
		const raw = serialize(text, styles);
		const back = toRich(raw);
		assert.equal(back.text, text, `text of ${JSON.stringify(raw)}`);
		for (let i = 0; i < len; i++) {
			if (text[i] === NL) continue;
			assert.deepEqual(back.styles[i], styles[i], `style ${i} of ${JSON.stringify(raw)}`);
		}
		// The raw offsets point at the characters.
		for (let i = 0; i < len; i++) assert.equal(raw[back.at[i]], text[i]);
		assert.equal(rawToPlain(back, raw.length), len);
	}
});

test("writing old text back keeps how it reads", () => {
	const r = rng(3);
	const chars = ["a", "b", " ", "*", "_", "=", BS, NL, "g"];
	for (let n = 0; n < 3000; n++) {
		let s = "";
		const len = r.int(0, 24);
		for (let i = 0; i < len; i++) s += r.pick(chars);
		const a = toRich(s);
		const b = toRich(serialize(a.text, a.styles));
		assert.equal(b.text, a.text, JSON.stringify(s));
		a.styles.forEach((st, i) => a.text[i] !== NL && assert.deepEqual(b.styles[i], st, JSON.stringify(s)));
	}
});

test("commonStyle", () => {
	const b: Style = { ...PLAIN, bold: true };
	const bh: Style = { ...PLAIN, bold: true, highlight: "pink" };
	assert.deepEqual(commonStyle([b, bh], 0, 2), { ...PLAIN, bold: true });
	assert.deepEqual(commonStyle([bh, bh], 0, 2), bh);
});

test("diffText edits turn a into b", () => {
	const r = rng(4);
	const apply = (a: string, ch: { from: number; to: number; insert: string }[]) => {
		let out = "";
		let pos = 0;
		for (const c of ch) {
			assert.ok(c.from >= pos, "changes in order");
			out += a.slice(pos, c.from) + c.insert;
			pos = c.to;
		}
		return out + a.slice(pos);
	};
	const chars = ["a", "b", "*", "=", " ", NL];
	for (let n = 0; n < 4000; n++) {
		const mk = () => Array.from({ length: r.int(0, 20) }, () => r.pick(chars)).join("");
		const a = mk();
		const b = r.bit() ? mk() : a.slice(0, r.int(0, a.length)) + mk() + a.slice(r.int(0, a.length));
		assert.equal(apply(a, diffText(a, b)), b, JSON.stringify([a, b]));
	}
});

test("adding markers is a pure insertion", () => {
	assert.deepEqual(diffText("Hey this", "**Hey** this"), [
		{ from: 0, to: 0, insert: "**" },
		{ from: 3, to: 3, insert: "**" },
	]);
});
