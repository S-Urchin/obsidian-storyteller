import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { findType, newBlock, newDoc } from "../src/doc";
import { addIssue, isInside, issueStats, moveIssue, naturalSort, nextIssueName, removePath, renamePath, safeFileName } from "../src/projects";
import { ComicProject } from "../src/types";
import { test } from "./harness";

const project = (name: string, folder: string, issues: string[] = []): ComicProject => ({ id: name, name, folder, exportFolder: null, issues: [...issues] });

test("an issue belongs to one project only", () => {
	const a = project("A", "A");
	const b = project("B", "B");
	const all = [a, b];
	assert.equal(addIssue(all, a, "A/one.comic"), null);
	assert.equal(addIssue(all, b, "A/one.comic"), a);
	assert.equal(addIssue(all, a, "A/one.comic"), a);
	assert.deepEqual(a.issues, ["A/one.comic"]);
	assert.deepEqual(b.issues, []);
});

test("issues reorder and keep their order", () => {
	const p = project("P", "", ["1", "2", "3", "4"]);
	moveIssue(p, 0, 2);
	assert.deepEqual(p.issues, ["2", "3", "1", "4"]);
	moveIssue(p, 3, 0);
	assert.deepEqual(p.issues, ["4", "2", "3", "1"]);
	moveIssue(p, 1, 99);
	assert.deepEqual(p.issues, ["4", "3", "1", "2"]);
	moveIssue(p, 9, 0);
	assert.deepEqual(p.issues, ["4", "3", "1", "2"]);
});

test("renames follow files and folders", () => {
	const p = project("P", "Comics/P", ["Comics/P/a.comic", "Comics/P/b.comic", "Elsewhere/c.comic"]);
	assert.ok(renamePath([p], "Comics/P/a.comic", "Comics/P/A1.comic"));
	assert.deepEqual(p.issues, ["Comics/P/A1.comic", "Comics/P/b.comic", "Elsewhere/c.comic"]);
	assert.ok(renamePath([p], "Comics", "Series"));
	assert.equal(p.folder, "Series/P");
	assert.deepEqual(p.issues, ["Series/P/A1.comic", "Series/P/b.comic", "Elsewhere/c.comic"]);
	// "Series/P" must not match "Series/Pilot".
	assert.equal(renamePath([project("Q", "Series/Pilot", ["Series/Pilot/x.comic"])], "Series/P", "Z"), false);
	assert.equal(renamePath([p], "Nope", "Still nope"), false);
});

test("deleting drops issues, folders included", () => {
	const p = project("P", "C", ["C/a.comic", "C/sub/b.comic", "D/c.comic"]);
	assert.ok(removePath([p], "C/sub"));
	assert.deepEqual(p.issues, ["C/a.comic", "D/c.comic"]);
	assert.ok(removePath([p], "D/c.comic"));
	assert.equal(removePath([p], "D/c.comic"), false);
	assert.deepEqual(p.issues, ["C/a.comic"]);
});

test("folders and names", () => {
	assert.ok(isInside("A/b.comic", "A"));
	assert.ok(isInside("A/x/b.comic", "A"));
	assert.ok(!isInside("AB/b.comic", "A"));
	assert.ok(isInside("anything.comic", ""));
	assert.deepEqual(naturalSort(["Issue 10", "Issue 2", "issue 1"]), ["issue 1", "Issue 2", "Issue 10"]);
	assert.equal(safeFileName('Who: "Me"?  #1'), "Who Me 1");
	const p = project("Night", "", ["x", "y"]);
	assert.deepEqual(nextIssueName(p, () => false), { basename: "Night - Issue 3", number: 3 });
	const taken = new Set(["Night - Issue 3", "Night - Issue 3 (2)"]);
	assert.equal(nextIssueName(p, (n) => taken.has(n)).basename, "Night - Issue 3 (3)");
});

test("stats count pages, words, balloons and cast", () => {
	const s = { ...DEFAULT_SETTINGS, newPanelBlocks: ["description"], newPagePanels: 2 };
	const doc = newDoc(s, "T");
	const [p1, p2] = doc.pages[0].panels;
	p1.blocks[0].text = "A **dark** alley.";
	const d = newBlock(findType(s, "dialogue"));
	d.speaker = "maya";
	d.text = "Who's there?";
	const c = newBlock(findType(s, "caption"));
	c.text = "Later.";
	const free = newBlock(findType(s, "freestyle"));
	free.text = "TO BE CONTINUED";
	p1.blocks.push(d, c);
	p2.blocks.push(free);
	p2.revision = true;
	p2.notes.push({ id: "n", text: "hm", author: "", created: 0, resolved: false, replies: [] });
	p2.notes.push({ id: "m", text: "ok", author: "", created: 0, resolved: true, replies: [] });
	const st = issueStats(doc, s);
	assert.equal(st.pages, 1);
	assert.equal(st.panels, 2);
	assert.equal(st.descriptionWords, 3 + 3);
	assert.equal(st.letteringWords, 2 + 1);
	assert.equal(st.balloons, 2);
	assert.equal(st.busiestPanelWords, 3);
	assert.deepEqual([...st.speakers], [["MAYA", 1], ["CAPTION", 1]]);
	assert.equal(st.openComments, 1);
	assert.equal(st.revisions, 1);
});
