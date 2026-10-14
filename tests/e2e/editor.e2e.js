// End-to-end tests for the block editor, driven in a running Obsidian.
//
//   1. Install the built plugin in a test vault (not your real one: the tests rewrite Demo/The Lighthouse.comic).
//   2. Start Obsidian with remote debugging:  Obsidian.exe --remote-debugging-port=9222
//   3. npm run test:e2e            (or: node tests/e2e/editor.e2e.js "part of a test name")
//
// Each test resets the demo script, acts like a person (mouse + keyboard), then checks the saved text and the
// screen. Failures leave a screenshot in your temp folder.
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const assert = require("node:assert/strict");
const { connect, sleep } = require("./lib");

const B = String.fromCharCode(92); // backslash
const DEMO = JSON.parse(fs.readFileSync(__dirname + "/demo.json", "utf8"));
const ID = "storyteller-comic-drafter";
const only = process.argv[2];

let page;
const results = [];
const errors = [];

async function reset(texts = {}, mutate) {
	await page.mouse.move(15, 400);
	const demo = JSON.parse(JSON.stringify(DEMO));
	const blocks = demo.pages.flatMap((p) => p.panels.flatMap((n) => n.blocks));
	for (const [i, t] of Object.entries(texts)) blocks[i].text = t;
	if (mutate) mutate(demo, blocks);
	await page.evaluate(
		async (json, ID) => {
			const s = app.plugins.plugins[ID].settings;
			s.authorName = "Writer";
			s.openAfterExport = false;
			if (!app.vault.getAbstractFileByPath("Demo")) await app.vault.createFolder("Demo");
			const f = app.vault.getAbstractFileByPath("Demo/The Lighthouse.comic") ?? (await app.vault.create("Demo/The Lighthouse.comic", json));
			const leaf = app.workspace.getLeaf(false);
			const old = leaf.view;
			if (old?.save) await old.save();
			await leaf.setViewState({ type: "empty" });
			// Closing saves the script; let that land before writing the fresh copy.
			await new Promise((r) => setTimeout(r, 400));
			await app.vault.modify(f, json);
			await new Promise((r) => setTimeout(r, 100));
			await leaf.openFile(f);
			window.box = (el) => (el && el.classList.contains("cm-editor") ? el.querySelector(".cm-content") : el);
			const text = leaf.view.doc?.pages?.[0]?.panels?.[0]?.blocks?.[0]?.text;
			const want = JSON.parse(json).pages[0].panels[0].blocks[0].text;
			if (text !== want) throw new Error("reset failed: " + text);
			document.activeElement?.blur?.();
		},
		JSON.stringify(demo, null, 2),
		ID
	);
	await sleep(700);
}

const view = () => "app.workspace.getLeaf(false).view";
/** Raw text of every block, in reading order. */
const raws = () => page.evaluate(() => app.workspace.getLeaf(false).view.doc.pages.flatMap((p) => p.panels.flatMap((n) => n.blocks.map((b) => b.text))));
const raw = async (i) => (await raws())[i];
/** What block i's editor shows. */
const shown = (i) => page.evaluate((i) => box(document.querySelectorAll(".st-sheet .st-text")[i])?.innerText.replace(/\n$/, ""), i);
const notes = (i) => page.evaluate((i) => app.workspace.getLeaf(false).view.doc.pages.flatMap((p) => p.panels.flatMap((n) => n.blocks))[i].notes, i);

/** Screen point just inside the left edge of visible character k in block i (k = length → after the last). */
async function charPoint(i, k) {
	const p = await page.evaluate(
		(i, k) => {
			const content = box(document.querySelectorAll(".st-sheet .st-text")[i]);
			const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest(".cm-placeholder, .st-placeholder") ? 2 : 1) });
			let node;
			let seen = 0;
			let last = null;
			while ((node = walker.nextNode())) {
				const len = node.textContent.length;
				if (k < seen + len) {
					const r = document.createRange();
					r.setStart(node, k - seen);
					r.setEnd(node, k - seen + 1);
					const b = r.getClientRects()[0];
					return { x: b.left + 1, y: b.top + b.height / 2 };
				}
				seen += len;
				last = node;
			}
			if (!last) {
				const b = content.getBoundingClientRect();
				return { x: b.left + 2, y: b.top + 8 };
			}
			const r = document.createRange();
			r.selectNodeContents(last);
			const rects = r.getClientRects();
			const b = rects[rects.length - 1];
			return { x: b.right + 2, y: b.top + b.height / 2 };
		},
		i,
		k
	);
	return p;
}

async function caret(i, k) {
	const p = await charPoint(i, k);
	await page.mouse.click(p.x, p.y);
	await sleep(80);
}

async function select(i, a, b) {
	const p = await charPoint(i, a);
	const q = await charPoint(i, b);
	await page.mouse.click(p.x, p.y);
	await page.keyboard.down("Shift");
	await page.mouse.click(q.x, q.y);
	await page.keyboard.up("Shift");
	await sleep(120);
}

/** Selects the first occurrence of `word` in block i's visible text. */
async function selectWord(i, word) {
	const text = await shown(i);
	const a = text.indexOf(word);
	assert.ok(a >= 0, `"${word}" not in "${text}"`);
	await select(i, a, a + word.length);
}

async function combo(...keys) {
	const last = keys.pop();
	for (const k of keys) await page.keyboard.down(k);
	await page.keyboard.press(last);
	for (const k of keys.reverse()) await page.keyboard.up(k);
	await sleep(120);
}

const html = (i) => page.evaluate((i) => box(document.querySelectorAll(".st-sheet .st-text")[i]).innerHTML, i);
/** Classes on the element holding `word` in block i. */
const classesOf = (i, word) =>
	page.evaluate(
		(i, word) => {
			const content = box(document.querySelectorAll(".st-sheet .st-text")[i]);
			const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
			let n;
			while ((n = walker.nextNode())) if (n.textContent.includes(word)) {
				const out = [];
				for (let e = n.parentElement; e && e !== content; e = e.parentElement) out.push(...e.classList);
				return out.filter((c) => c.startsWith("st-")).sort().join(" ");
			}
			return null;
		},
		i,
		word
	);

async function test(name, fn) {
	if (only && !name.includes(only)) return;
	const before = errors.length;
	try {
		await fn();
		if (errors.length > before) throw new Error("console errors:\n" + errors.slice(before).join("\n"));
		results.push(["ok", name]);
		console.log("  ok   " + name);
	} catch (e) {
		results.push(["FAIL", name]);
		console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").join("\n       "));
		const shot = path.join(os.tmpdir(), `storyteller-e2e-fail-${results.length}.png`);
		await page.screenshot({ path: shot });
		console.log("       screenshot: " + shot);
	}
	await page.keyboard.press("Escape");
	await page.mouse.up().catch(() => {});
}

const D0 = "Wide shot. A storm batters a lonely lighthouse on a black rock. One window glows.";

(async () => {
	({ page } = await connect());
	page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
	page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

	await test("old markers are hidden and styled", async () => {
		await reset({ 0: "A **storm** and *lonely* __black__ ==yellow== =o=orange=o= **bold =p=pink=p=**" });
		assert.equal(await shown(0), "A storm and lonely black yellow orange bold pink");
		assert.equal(await classesOf(0, "storm"), "st-b");
		assert.equal(await classesOf(0, "lonely"), "st-i");
		assert.equal(await classesOf(0, "black"), "st-u");
		assert.equal(await classesOf(0, "orange"), "st-mark st-mark-orange");
		assert.equal(await classesOf(0, "pink"), "st-b st-mark st-mark-pink");
	});

	await test("typing plain text", async () => {
		await reset();
		await caret(0, D0.length);
		await page.keyboard.type(" Hello there.");
		assert.equal(await raw(0), D0 + " Hello there.");
		assert.equal(await shown(0), D0 + " Hello there.");
	});

	await test("typed * _ = \\ stay characters", async () => {
		await reset({ 0: "Math:" });
		await caret(0, 5);
		await page.keyboard.type(" 5 * 3 = 15, a_b, a == b, **no**, c:" + B + "x");
		const want = "Math: 5 * 3 = 15, a_b, a == b, **no**, c:" + B + "x";
		assert.equal(await shown(0), want);
		const r = await raw(0);
		assert.ok(r.includes(B + "*") && r.includes(B + "=") && r.includes(B + "_") && r.includes(B + B), r);
		await reset({ 0: r });
		assert.equal(await shown(0), want, "same after reopening");
	});

	await test("Ctrl+B bolds the selection, again removes it", async () => {
		await reset();
		await selectWord(0, "storm");
		await combo("Control", "b");
		assert.equal(await raw(0), D0.replace("storm", "**storm**"));
		assert.equal(await shown(0), D0);
		assert.equal(await classesOf(0, "storm"), "st-b");
		await combo("Control", "b");
		assert.equal(await raw(0), D0);
	});

	await test("Ctrl+I and Ctrl+U", async () => {
		await reset();
		await selectWord(0, "lonely");
		await combo("Control", "i");
		await selectWord(0, "black");
		await combo("Control", "u");
		assert.equal(await raw(0), D0.replace("lonely", "*lonely*").replace("black", "__black__"));
	});

	await test("bold and a highlight on the same words (toolbar)", async () => {
		await reset();
		await selectWord(0, "One window glows.");
		const bar = await page.waitForSelector(".st-format-bar.is-visible", { timeout: 2000 });
		assert.ok(bar, "format bar shows");
		await page.click('.st-format-bar.is-visible [data-style="bold"]');
		await sleep(150);
		await page.click(".st-format-bar.is-visible .st-format-btn-highlight");
		await sleep(150);
		await page.click('.st-highlight-pop.is-visible [data-color="orange"]');
		await sleep(150);
		assert.equal(await shown(0), D0);
		assert.equal(await classesOf(0, "One window"), "st-b st-mark st-mark-orange");
		const r = await raw(0);
		assert.ok(r.includes("One window glows."), r);
		// Buttons show what the selection has.
		const active = await page.evaluate(() => [...document.querySelectorAll(".st-format-bar .is-active")].map((b) => b.dataset.style || "highlight"));
		assert.deepEqual(active.sort(), ["bold", "highlight"]);
	});

	await test("Ctrl+B with nothing selected styles what's typed next", async () => {
		await reset({ 0: "Start" });
		await caret(0, 5);
		await combo("Control", "b");
		await page.keyboard.type(" loud");
		await combo("Control", "b");
		await page.keyboard.type(" quiet");
		assert.equal(await raw(0), "Start** loud** quiet");
		assert.equal(await shown(0), "Start loud quiet");
	});

	await test("typing at the end of bold words carries the bold on", async () => {
		await reset({ 0: "A **storm** here" });
		await caret(0, 7); // after "storm"
		await page.keyboard.type("y");
		assert.equal(await raw(0), "A **stormy** here");
	});

	await test("arrow keys step over hidden markers one character at a time", async () => {
		await reset({ 0: "A **storm** =o=x=o= end" });
		await caret(0, 0);
		for (let k = 0; k < "A storm".length; k++) await page.keyboard.press("ArrowRight");
		await page.keyboard.type("!");
		assert.equal(await shown(0), "A storm! x end");
		await caret(0, "A storm! x".length);
		for (let k = 0; k < 2; k++) await page.keyboard.press("ArrowLeft");
		await page.keyboard.type("?");
		assert.equal(await shown(0), "A storm!? x end");
	});

	await test("Backspace right after bold deletes the last bold letter", async () => {
		await reset({ 0: "A **storm** here" });
		await caret(0, 7);
		await page.keyboard.press("Backspace");
		assert.equal(await raw(0), "A **stor** here");
		await caret(0, 2);
		await page.keyboard.press("Delete");
		assert.equal(await raw(0), "A **tor** here");
	});

	await test("deleting across a style edge keeps the text balanced", async () => {
		await reset({ 0: "A **storm** batters =o=the=o= rock" });
		await selectWord(0, "orm batters th");
		await page.keyboard.press("Delete");
		assert.equal(await shown(0), "A ste rock");
		assert.equal(await raw(0), "A **st**=o=e=o= rock");
	});

	await test("replacing a bold selection keeps it bold", async () => {
		await reset({ 0: "A **storm** here" });
		await selectWord(0, "storm");
		await page.keyboard.type("gale");
		assert.equal(await raw(0), "A **gale** here");
	});

	await test("Enter makes a new line; styles close at line ends", async () => {
		await reset({ 0: "first line" });
		await caret(0, 10);
		await page.keyboard.press("Enter");
		await page.keyboard.type("second line");
		assert.equal(await shown(0), "first line\nsecond line");
		// Select "line⏎second" with Shift+→ (one press per visible character).
		await caret(0, 6);
		await page.keyboard.down("Shift");
		for (let k = 0; k < 11; k++) await page.keyboard.press("ArrowRight");
		await page.keyboard.up("Shift");
		await combo("Control", "b");
		assert.equal(await raw(0), "first **line**\n**second** line");
	});

	await test("Ctrl+Z / Ctrl+Y inside the field", async () => {
		await reset({ 0: "base" });
		await caret(0, 4);
		await page.keyboard.type(" text");
		assert.equal(await raw(0), "base text", "after typing");
		await selectWord(0, "base");
		assert.equal(await raw(0), "base text", "after selecting");
		await combo("Control", "b");
		assert.equal(await raw(0), "**base** text");
		await combo("Control", "z");
		assert.equal(await raw(0), "base text");
		await combo("Control", "z");
		assert.equal(await raw(0), "base");
		await combo("Control", "y");
		assert.equal(await raw(0), "base text");
		await combo("Control", "Shift", "z");
		assert.equal(await raw(0), "**base** text");
	});

	await test("copy gives plain text; paste between blocks keeps formatting", async () => {
		await reset({ 0: "A **storm** and =o=fire=o=", 1: "Caption" });
		await selectWord(0, "storm and fire");
		await page.keyboard.down("Control");
		await page.keyboard.press("KeyC", { commands: ["copy"] });
		await page.keyboard.up("Control");
		await sleep(100);
		const clip = await page.evaluate(() => window.require("electron").clipboard.readText());
		assert.equal(clip, "storm and fire");
		await caret(1, 7);
		await page.keyboard.down("Control");
		await page.keyboard.press("KeyV", { commands: ["paste"] });
		await page.keyboard.up("Control");
		await sleep(150);
		assert.equal(await shown(1), "Captionstorm and fire");
		assert.equal(await raw(1), "Caption**storm** and =o=fire=o=");
	});

	await test("pasting outside text with * and = keeps them as characters", async () => {
		await reset({ 0: "x" });
		await page.evaluate(() => window.require("electron").clipboard.writeText("a*b ==c== **d**"));
		await caret(0, 1);
		await page.keyboard.down("Control");
		await page.keyboard.press("KeyV", { commands: ["paste"] });
		await page.keyboard.up("Control");
		await sleep(150);
		assert.equal(await shown(0), "xa*b ==c== **d**");
	});

	await test("cut removes the words and keeps the rest balanced", async () => {
		await reset({ 0: "A **storm** here" });
		await selectWord(0, "orm he");
		await page.keyboard.down("Control");
		await page.keyboard.press("KeyX", { commands: ["cut"] });
		await page.keyboard.up("Control");
		await sleep(150);
		assert.equal(await raw(0), "A **st**re");
		assert.equal(await page.evaluate(() => window.require("electron").clipboard.readText()), "orm he");
	});

	await test("↓ at the end and ↑ at the start move between fields", async () => {
		await reset({ 0: "A **bold**" });
		await caret(0, 6); // end, after hidden closing marker
		await page.keyboard.press("ArrowDown");
		await sleep(100);
		let active = await page.evaluate(() => (document.activeElement?.closest(".cm-editor") ? "editor:" + [...document.querySelectorAll(".st-sheet .st-text")].indexOf(document.activeElement.closest(".cm-editor")) : document.activeElement?.classList.contains("st-speaker") ? "st-speaker" : document.activeElement?.className));
		assert.equal(active, "st-speaker", "down into the caption's speaker field");
		await page.keyboard.press("ArrowUp");
		await sleep(100);
		active = await page.evaluate(() => document.activeElement?.closest(".cm-editor") ? "editor:" + [...document.querySelectorAll(".st-sheet .st-text")].indexOf(document.activeElement.closest(".cm-editor")) : document.activeElement?.className);
		assert.equal(active, "editor:0", "back up");
		await page.keyboard.type("!");
		assert.equal(await raw(0), "A **bold!**", "landed at the end, inside the bold");
	});

	await test("Ctrl+Enter adds a block of the same type and focuses it", async () => {
		await reset();
		const n = (await raws()).length;
		await caret(3, 5); // the MAYA dialogue
		await combo("Control", "Enter");
		await sleep(300);
		await page.keyboard.type("new line");
		const r = await raws();
		assert.equal(r.length, n + 1);
		const types = await page.evaluate(() => app.workspace.getLeaf(false).view.doc.pages[0].panels[1].blocks.map((b) => b.typeId));
		assert.deepEqual(types, ["description", "dialogue", "dialogue", "sfx"]);
	});

	await test("Alt+↓ moves the block and keeps the cursor in it", async () => {
		await reset();
		await caret(3, 4);
		await combo("Alt", "ArrowDown");
		await sleep(300);
		const ids = await page.evaluate(() => app.workspace.getLeaf(false).view.doc.pages[0].panels[1].blocks.map((b) => b.typeId));
		assert.deepEqual(ids, ["description", "sfx", "dialogue"]);
		await page.keyboard.type("X");
		const r = await raws();
		assert.equal(r[4], "Not Xtonight, old girl. Not tonight.");
	});

	await test("Esc leaves the field and Ctrl+Z undoes the whole edit", async () => {
		await reset();
		await caret(0, D0.length);
		await page.keyboard.type(" More.");
		await page.keyboard.press("Escape");
		await sleep(100);
		await combo("Control", "z");
		await sleep(300);
		assert.equal(await raw(0), D0);
		assert.equal(await shown(0), D0);
	});

	await test("comment on words survives typing and bolding around it", async () => {
		await reset();
		await selectWord(0, "lighthouse");
		await combo("Control", "Alt", "m");
		await sleep(400);
		await page.keyboard.type("Make it tiny.");
		await combo("Control", "Enter");
		await sleep(400);
		let n = (await notes(0))[0];
		let r = await raw(0);
		assert.equal(r.slice(n.range.start, n.range.end), "lighthouse");
		// Type before it, then bold it.
		await caret(0, 0);
		await page.keyboard.type("Very ");
		n = (await notes(0))[0];
		r = await raw(0);
		assert.equal(r.slice(n.range.start, n.range.end), "lighthouse", "after typing before it: " + JSON.stringify(n.range));
		await selectWord(0, "lighthouse");
		n = (await notes(0))[0];
		r = await raw(0);
		assert.equal(r.slice(n.range.start, n.range.end), "lighthouse", "after selecting: " + JSON.stringify(n.range));
		await combo("Control", "b");
		n = (await notes(0))[0];
		r = await raw(0);
		assert.equal(r.slice(n.range.start, n.range.end).replace(/\*/g, ""), "lighthouse", r + " " + JSON.stringify(n.range));
		const marked = await page.evaluate(() => document.querySelector(".st-sheet .st-cmt")?.textContent);
		assert.equal(marked, "lighthouse");
		// The card sits level with the word.
		const dy = await page.evaluate(() => {
			const w = document.querySelector(".st-sheet .st-cmt").getBoundingClientRect();
			const c = document.querySelector(".st-comment[data-note]").getBoundingClientRect();
			return Math.abs(w.top - c.top);
		});
		assert.ok(dy < 40, "card near its word, off by " + dy);
	});

	await test("locked block: no typing, but selecting and commenting work", async () => {
		await reset({}, (demo, blocks) => (blocks[0].locked = true));
		await caret(0, 5);
		await page.keyboard.type("zzz");
		assert.equal(await raw(0), D0);
		await selectWord(0, "storm");
		await combo("Control", "b");
		assert.equal(await raw(0), D0, "no formatting on a locked block");
		await combo("Control", "Alt", "m");
		await sleep(300);
		assert.ok(await page.$(".st-comment-draft"), "draft comment opens");
	});

	await test("read mode shows formatted text without markers", async () => {
		await reset({ 0: "A **storm** and =o=fire=o= 5 " + B + "* 3" });
		await page.evaluate(() => app.workspace.getLeaf(false).view.setReadMode(true));
		await sleep(500);
		const t = await page.evaluate(() => [...document.querySelectorAll(".st-r-p")].map((p) => p.innerText).find((x) => x.includes("storm")));
		assert.ok(t.includes("A storm and fire 5 * 3"), t);
		await page.evaluate(() => app.workspace.getLeaf(false).view.setReadMode(false));
		await sleep(400);
	});

	await test("Word export: styles become runs, no markers or backslashes", async () => {
		await reset({ 0: "A **storm** and **=o=fire=o=** 5 " + B + "* 3 " + B + "= 15" });
		const bytes = await page.evaluate(async (ID) => {
			const plugin = app.plugins.plugins[ID];
			const v = app.workspace.getLeaf(false).view;
			await plugin.exportView(v, "Exported");
			await new Promise((r) => setTimeout(r, 800));
			const file = app.vault.getAbstractFileByPath("Exported/The Lighthouse.docx");
			return file ? Array.from(new Uint8Array(await app.vault.readBinary(file))) : null;
		}, ID);
		assert.ok(bytes, "a .docx was exported");
		const xml = await (await JSZip.loadAsync(Buffer.from(bytes))).file("word/document.xml").async("string");
		const para = xml.split("<w:p>").find((p) => p.includes("storm"));
		const runs = [...para.matchAll(/<w:r>(.*?)<\/w:r>/g)].map((m) => {
			const t = (m[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/) || [])[1] ?? "";
			const f = [/<w:b\/>/.test(m[1]) && "b", /<w:highlight w:val="(\w+)"/.exec(m[1])?.[1]].filter(Boolean).join("+");
			return f ? `[${f}]${t}` : t;
		});
		const text = runs.join("|");
		assert.ok(text.includes("[b]storm") && text.includes("[b+darkYellow]fire"), text);
		const words = runs.map((r) => r.replace(/^\[[^\]]*\]/, "")).join("");
		assert.ok(!words.includes(B) && !words.includes("**") && !words.includes("==") && !words.includes("=o="), "no markers in Word: " + text);
		assert.ok(words.includes("5 * 3 = 15"), words);
		await page.evaluate(async () => {
			const f = app.vault.getAbstractFileByPath("Exported/The Lighthouse.docx");
			if (f) await app.vault.delete(f);
			const d = app.vault.getAbstractFileByPath("Exported");
			if (d && !d.children.length) await app.vault.delete(d, true);
		});
	});

	await test("freestyle alignment and the panel label indent still apply", async () => {
		await reset({}, (demo) => {
			demo.pages[1].panels[0].blocks.push({ id: "fs1", locked: false, revision: false, pinned: false, notes: [], typeId: "freestyle", speaker: "", modifier: "", text: "THE END", format: { align: "center", indent: false, size: "large", box: false } });
		});
		const look = () => page.evaluate(() => {
			const line = (el) => el.querySelector(".cm-line") ?? el;
			const eds = [...document.querySelectorAll(".st-sheet .st-text")];
			const fs = eds.find((e) => e.innerText.includes("THE END"));
			return { align: getComputedStyle(line(fs)).textAlign, indent: getComputedStyle(line(eds[0])).textIndent };
		});
		let l = await look();
		assert.equal(l.align, "center", "drawn");
		assert.ok(parseFloat(l.indent) > 50, "first line indented past 'Panel 1:' (" + l.indent + ")");
		// The same once they're editors.
		await page.evaluate(() => [...document.querySelectorAll(".st-sheet .st-text-static")].forEach((h) => h.dispatchEvent(new MouseEvent("mouseenter"))));
		await sleep(150);
		l = await look();
		assert.equal(l.align, "center", "editor");
		assert.ok(parseFloat(l.indent) > 50, "editor indent " + l.indent);
	});

	await test("saved file has the markers; reopening shows the same", async () => {
		await reset();
		await selectWord(0, "storm");
		await combo("Control", "b");
		await page.evaluate(() => app.workspace.getLeaf(false).view.save?.());
		await sleep(2500);
		const disk = await page.evaluate(async () => app.vault.read(app.vault.getAbstractFileByPath("Demo/The Lighthouse.comic")));
		assert.ok(disk.includes("**storm**"), "on disk");
		await page.evaluate(async () => {
			const leaf = app.workspace.getLeaf(false);
			const f = leaf.view.file;
			await leaf.setViewState({ type: "empty" });
			await leaf.openFile(f);
		});
		await sleep(700);
		assert.equal(await shown(0), D0);
		assert.equal(await classesOf(0, "storm"), "st-b");
	});

	await test("dragging a block still works over the text", async () => {
		await reset();
		const grip = await page.evaluate(() => {
			const ed = [...document.querySelectorAll(".st-sheet .st-text")].find((e) => e.innerText.includes("KRAKOOOM"));
			const h = ed.closest(".st-block").querySelector(".st-handle").getBoundingClientRect();
			return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
		});
		const target = await charPoint(3, 3);
		await page.mouse.move(grip.x, grip.y + 20);
		await sleep(150);
		await page.setDragInterception(true);
		const data = await page.mouse.drag(grip, { x: grip.x, y: grip.y - 4 });
		await page.mouse.dragEnter({ x: target.x, y: target.y - 6 }, data);
		await page.mouse.dragOver({ x: target.x, y: target.y - 6 }, data);
		await sleep(200);
		await page.mouse.drop({ x: target.x, y: target.y - 6 }, data);
		await page.setDragInterception(false);
		await sleep(400);
		const types = await page.evaluate(() => app.workspace.getLeaf(false).view.doc.pages[0].panels[1].blocks.map((b) => b.typeId));
		assert.deepEqual(types, ["description", "sfx", "dialogue"]);
		assert.ok(!(await raws()).some((t) => t.includes("storyteller")), "nothing dropped into the text");
	});

	await test("Ctrl+Shift+H highlights; the popover's ✕ removes it", async () => {
		await reset();
		await selectWord(0, "storm");
		await combo("Control", "Shift", "h");
		assert.equal(await raw(0), D0.replace("storm", "==storm=="));
		await page.click(".st-format-bar.is-visible .st-format-btn-highlight");
		await sleep(150);
		await page.click(".st-highlight-pop.is-visible .st-highlight-none");
		await sleep(150);
		assert.equal(await raw(0), D0);
	});

	await test("Ctrl+Shift+Enter adds a panel; Ctrl+E switches to Read mode from inside text", async () => {
		await reset();
		const panels = () => page.evaluate(() => app.workspace.getLeaf(false).view.doc.pages[0].panels.length);
		const before = await panels();
		await caret(0, 3);
		await combo("Control", "Shift", "Enter");
		await sleep(300);
		assert.equal(await panels(), before + 1);
		await caret(0, 3);
		await combo("Control", "e");
		await sleep(400);
		assert.ok(await page.$(".st-r-p"), "read mode");
		await combo("Control", "e");
		await sleep(400);
		assert.ok(await page.$(".st-sheet .st-text"), "back to edit mode");
	});

	await test("selecting with a mouse drag across hidden markers", async () => {
		await reset({ 0: "A **storm** batters =o=the=o= rock" });
		const a = await charPoint(0, 4);
		const b = await charPoint(0, 15);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move((a.x + b.x) / 2, b.y, { steps: 5 });
		await page.mouse.move(b.x, b.y, { steps: 5 });
		await page.mouse.up();
		await sleep(150);
		const sel = await page.evaluate(() => window.getSelection().toString());
		assert.equal(sel, "orm batters");
		await combo("Control", "i");
		assert.equal(await shown(0), "A storm batters the rock");
		assert.equal(await classesOf(0, "orm"), "st-b st-i");
		assert.equal(await classesOf(0, " batters"), "st-i");
	});

	await test("Ctrl+A selects only this block's text", async () => {
		await reset();
		await caret(0, 5);
		await combo("Control", "a");
		await page.keyboard.type("Replaced.");
		const r = await raws();
		assert.equal(r[0], "Replaced.");
		assert.equal(r[1], "Thirty years I kept the light.");
	});

	await test("Tab moves on from the speaker to the line, as before", async () => {
		await reset();
		await page.click(".st-sheet input.st-speaker:not([readonly])");
		await page.keyboard.press("End");
		await page.keyboard.press("Tab");
		await sleep(100);
		await page.keyboard.type("Hey. ");
		const r = await raws();
		assert.ok(r[3].startsWith("Hey. ") || r.some((t) => t.startsWith("Hey. ")), JSON.stringify(r));
	});

	await test("pasting several lines", async () => {
		await reset({ 0: "x" });
		await page.evaluate(() => window.require("electron").clipboard.writeText("one\ntwo *3*\nfour"));
		await caret(0, 1);
		await page.keyboard.down("Control");
		await page.keyboard.press("KeyV", { commands: ["paste"] });
		await page.keyboard.up("Control");
		await sleep(150);
		assert.equal(await shown(0), "xone\ntwo *3*\nfour");
	});

	await test("IME composition goes in as typed", async () => {
		await reset({ 0: "名前: " });
		await caret(0, 4);
		const cdp = await page.createCDPSession();
		await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
		await sleep(80);
		await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
		await sleep(80);
		await cdp.send("Input.insertText", { text: "仮名" });
		await sleep(200);
		await cdp.detach();
		assert.equal(await shown(0), "名前: 仮名");
		assert.equal(await raw(0), "名前: 仮名");
	});

	await test("old text with stray markers reads the same after editing elsewhere", async () => {
		await reset({ 0: "5 * 3 = 15 and a == b, x_y" });
		await caret(0, 0);
		await page.keyboard.type("So ");
		assert.equal(await shown(0), "So 5 * 3 = 15 and a == b, x_y");
		await reset({ 0: await raw(0) });
		assert.equal(await shown(0), "So 5 * 3 = 15 and a == b, x_y");
	});

	await test("empty block shows its placeholder; spellcheck is on", async () => {
		await reset({ 1: "" });
		let ph = await page.evaluate(() => document.querySelectorAll(".st-sheet .st-text")[1].querySelector(".st-placeholder, .cm-placeholder")?.textContent);
		assert.equal(ph, "Caption…", "drawn");
		await caret(1, 0);
		ph = await page.evaluate(() => document.querySelectorAll(".st-sheet .st-text")[1].querySelector(".cm-placeholder")?.textContent);
		assert.equal(ph, "Caption…", "editor");
		const sc = await page.evaluate(() => document.querySelector(".st-sheet .cm-content").getAttribute("spellcheck"));
		assert.equal(sc, "true");
	});

	await test("redrawing many times doesn't leave editors behind", async () => {
		await reset();
		const count = () => page.evaluate(() => ({ live: app.workspace.getLeaf(false).view.editors.size, dom: document.querySelectorAll(".cm-editor.st-text").length }));
		const before = await count();
		await page.evaluate(() => { const v = app.workspace.getLeaf(false).view; for (let i = 0; i < 40; i++) v.renderAll(); });
		await sleep(300);
		const after = await count();
		assert.deepEqual(after, before);
		assert.equal(after.live, after.dom);
	});

	await test("a long script stays quick (600+ blocks)", async () => {
		await reset({}, (demo) => {
			const page0 = demo.pages[0];
			demo.pages = [];
			for (let p = 0; p < 40; p++) {
				const pg = JSON.parse(JSON.stringify(page0));
				let n = 0;
				const re = (o) => { o.id = "p" + p + "x" + n++; (o.panels || o.blocks || []).forEach(re); };
				re(pg);
				for (const panel of pg.panels) while (panel.blocks.length < 8) panel.blocks.push({ ...JSON.parse(JSON.stringify(panel.blocks[0])), id: "p" + p + "x" + n++, text: "More **words** for the panel, =o=some=o= highlighted." });
				demo.pages.push(pg);
			}
		});
		const t = await page.evaluate(() => {
			const v = app.workspace.getLeaf(false).view;
			const t0 = performance.now();
			v.renderAll();
			return { ms: Math.round(performance.now() - t0), fields: document.querySelectorAll(".st-sheet .st-text").length };
		});
		console.log("       render:", JSON.stringify(t));
		assert.ok(t.fields >= 600, "fields: " + t.fields);
		assert.ok(t.ms < 700, "full redraw took " + t.ms + " ms (the old textarea editor took ~510)");
		// Typing in a long script: time per keystroke.
		await caret(0, 4);
		const t1 = Date.now();
		await page.keyboard.type("abcdefghij");
		const per = (Date.now() - t1) / 10;
		console.log("       typing: " + per + " ms per key");
		assert.ok(per < 60, "typing " + per + " ms per key");
	});

	await test("hovering turns drawn text into an editor without moving it", async () => {
		await reset({ 0: "A **storm** batters a lonely =o=lighthouse=o= on a black rock. One window glows, far out at sea." });
		const measure = () =>
			page.evaluate(() => {
				const el = document.querySelectorAll(".st-sheet .st-text")[0];
				const r = el.getBoundingClientRect();
				const t = box(el);
				const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
				const rects = [];
				let n;
				while ((n = walker.nextNode())) {
					const g = document.createRange();
					g.selectNodeContents(n);
					for (const q of g.getClientRects()) rects.push([Math.round(q.left), Math.round(q.top), Math.round(q.right)]);
				}
				return { kind: el.classList.contains("cm-editor") ? "editor" : "drawn", h: Math.round(r.height), w: Math.round(r.width), first: rects[0], last: rects[rects.length - 1] };
			});
		const before = await measure();
		assert.equal(before.kind, "drawn");
		const p = await charPoint(0, 3);
		await page.mouse.move(p.x, p.y);
		await sleep(200);
		const after = await measure();
		assert.equal(after.kind, "editor");
		assert.deepEqual({ ...after, kind: 0 }, { ...before, kind: 0 }, "same layout");
		assert.equal(await page.evaluate(() => app.workspace.getLeaf(false).view.editors.size), 1, "only that block");
	});

	await test("Tab into drawn text gives an editor with the cursor", async () => {
		await reset();
		await page.click(".st-sheet input.st-byline");
		const order = [];
		for (let k = 0; k < 4; k++) {
			await page.keyboard.press("Tab");
			await sleep(80);
			order.push(await page.evaluate(() => (document.activeElement?.closest(".cm-editor") ? "text" : document.activeElement?.getAttribute("aria-label"))));
		}
		assert.deepEqual(order, ["Collapse", "Page options", "Collapse", "text"]);
		await page.keyboard.type("Tabbed. ");
		assert.equal(await raw(0), "Tabbed. " + D0);
	});

	await test("pressing drawn text without hovering puts the cursor there", async () => {
		await reset();
		const p = await charPoint(0, 5); // before "shot"
		await page.evaluate(({ x, y }) => {
			const el = document.elementFromPoint(x, y).closest(".st-text-static");
			el.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true, cancelable: true }));
		}, p);
		await sleep(150);
		await page.keyboard.type("X");
		assert.equal(await raw(0), D0.replace("shot", "Xshot"));
	});

	await test("comment on a block that isn't an editor yet lines up with its word", async () => {
		await reset({}, (demo, blocks) => {
			const t = blocks[6].text;
			const at = t.indexOf("Halcyon");
			blocks[6].notes.push({ id: "c1", text: "Name of the ship.", author: "Writer", created: 0, resolved: false, replies: [], range: { start: at, end: at + 7 } });
		});
		await sleep(400);
		const r = await page.evaluate(() => {
			const w = document.querySelector(".st-sheet .st-text-static .st-cmt");
			const c = document.querySelector(".st-comment[data-note]");
			return { word: w?.textContent, dy: Math.abs(w.getBoundingClientRect().top - c.getBoundingClientRect().top) };
		});
		assert.equal(r.word, "Halcyon");
		assert.ok(r.dy < 40, "card off by " + r.dy);
	});

	const ok = results.filter((r) => r[0] === "ok").length;
	console.log(`${ok} passed, ${results.length - ok} failed`);
	process.exit(results.length - ok ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(2);
});
