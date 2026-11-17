import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { balloonNumbers, cloneWithNewIds, findType, newBlock, newDoc, newPanel, normalizeDoc } from "../src/doc";
import { exportDocx, ExportImage } from "../src/export-docx";
import { docHasImages, fileName, fitImage, imageType, loadBlockImage, panelsWithImages, pathMatches, renameDocImages, renameImage } from "../src/images";
import { issueStats } from "../src/projects";

const settings = { ...DEFAULT_SETTINGS, newPanelBlocks: ["description"] };
const script = () => {
	const doc = newDoc(settings, "Images");
	const block = doc.pages[0].panels[0].blocks[0];
	block.text = "Wide shot of the lighthouse.";
	block.image = { path: "Art/Panel one.png", alt: "A lighthouse in a storm", hidden: false };
	return doc;
};
const png: ExportImage = {
	type: "png", width: 1, height: 1,
	data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=", "base64"),
};
const media = (zip: JSZip) => Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name].dir);
const documentXml = async (zip: JSZip) => zip.file("word/document.xml")!.async("string");

test("there is no image block type, and the Word appendix is off by default", () => {
	assert.equal(DEFAULT_SETTINGS.blockTypes.some((t) => t.id === "image"), false);
	assert.equal(DEFAULT_SETTINGS.quickAdd.includes("type:image"), false);
	assert.equal(DEFAULT_SETTINGS.exportReferences, false);
	assert.equal(newPanel(settings).blocks[0].image, undefined);
});

test("a block's image and hidden state survive save and reopen", () => {
	const doc = script();
	doc.pages[0].panels[0].blocks[0].image!.hidden = true;
	assert.deepEqual(normalizeDoc(JSON.parse(JSON.stringify(doc)), "Fallback"), doc);
});

test("scripts without images load unchanged", () => {
	const doc = newDoc(settings, "Old script");
	assert.deepEqual(normalizeDoc(JSON.parse(JSON.stringify(doc)), "Fallback"), doc);
	assert.equal(docHasImages(doc), false);
	assert.equal(docHasImages(script()), true);
});

test("old image blocks become description blocks carrying their image", () => {
	const raw = {
		title: "Old",
		pages: [{
			panels: [{
				blocks: [
					{ id: "d", typeId: "description", text: "Panel text" },
					{ id: "i", typeId: "image", text: "Rough layout", image: { path: "Art/a.png", alt: "Sketch", hidden: true }, notes: [{ id: "n", text: "Redraw" }] },
					{ id: "e", typeId: "image", text: "" },
					{ id: "t", typeId: "image", text: "Words but no picture" },
					{ id: "c", typeId: "dialogue", speaker: "MAYA", text: "Hi", image: { path: "Art/b.png" } },
				],
			}],
		}],
	};
	const blocks = normalizeDoc(raw, "Old").pages[0].panels[0].blocks;
	assert.deepEqual(blocks.map((b) => [b.id, b.typeId, b.text, b.image?.path]), [
		["d", "description", "Panel text", undefined],
		["i", "description", "Rough layout", "Art/a.png"],
		["t", "description", "Words but no picture", undefined],
		["c", "dialogue", "Hi", "Art/b.png"],
	]);
	assert.equal(blocks[1].image!.hidden, true);
	assert.equal(blocks[1].notes[0].text, "Redraw");
});

test("panel-wide images from the dock draft move onto blocks, one per block", () => {
	const raw = {
		pages: [{
			panels: [{
				blocks: [{ id: "d", typeId: "description", text: "Panel" }],
				images: [{ id: "1", path: "a.png", alt: "A", note: "" }, { id: "2", path: "b.png", alt: "", note: "Coat is green" }, { path: "" }],
			}],
		}],
	};
	const blocks = normalizeDoc(raw, "Draft").pages[0].panels[0].blocks;
	assert.deepEqual(blocks.map((b) => [b.text, b.image?.path]), [["Panel", "a.png"], ["Coat is green", "b.png"]]);
	assert.equal("images" in normalizeDoc(raw, "Draft").pages[0].panels[0], false);
});

test("image loading rejects malformed values and fills missing fields", () => {
	for (const bad of [null, undefined, [], "image.png", { path: 4 }, { path: "" }]) assert.equal(loadBlockImage(bad), undefined);
	assert.deepEqual(loadBlockImage({ path: "Art/a.png", alt: 4, hidden: "true" }), { path: "Art/a.png", alt: "", hidden: false });
	assert.equal(fileName("Art/Sketches/a.png"), "a.png");
});

test("duplicating a page copies images without sharing them", () => {
	const doc = script();
	const copy = cloneWithNewIds(doc.pages[0]);
	assert.deepEqual(copy.panels[0].blocks[0].image, doc.pages[0].panels[0].blocks[0].image);
	copy.panels[0].blocks[0].image!.hidden = true;
	assert.equal(doc.pages[0].panels[0].blocks[0].image!.hidden, false);
});

test("image formats are limited to vault raster attachments", () => {
	assert.equal(imageType("PNG"), "png");
	assert.equal(imageType("jpeg"), "jpg");
	assert.equal(imageType("jpg"), "jpg");
	assert.equal(imageType("gif"), "gif");
	assert.equal(imageType("bmp"), "bmp");
	for (const ext of ["md", "svg", "webp", "exe", ""]) assert.equal(imageType(ext), null);
});

test("images follow file and folder renames without prefix collisions", () => {
	const doc = script();
	assert.equal(renameDocImages(doc, "Art/Panel one.png", "Art/New name.png"), true);
	assert.equal(renameDocImages(doc, "Art", "Visuals"), true);
	assert.equal(doc.pages[0].panels[0].blocks[0].image!.path, "Visuals/New name.png");
	assert.equal(renameDocImages(doc, "Visual", "Wrong"), false);
	assert.equal(renameImage(undefined, "Visuals", "Other"), false);
	assert.equal(pathMatches("Visuals/a.png", "Visuals"), true);
	assert.equal(pathMatches("Visuals2/a.png", "Visuals"), false);
});

test("images don't change word counts or balloon numbers", () => {
	const doc = script();
	const dialogue = newBlock(findType(settings, "dialogue"));
	dialogue.text = "Hello there";
	dialogue.image = { path: "b.png", alt: "", hidden: false };
	doc.pages[0].panels[0].blocks.push(dialogue);
	assert.deepEqual([...balloonNumbers(doc, settings, "page").values()], [1]);
	const stats = issueStats(doc, settings);
	assert.equal(stats.descriptionWords, 5);
	assert.equal(stats.letteringWords, 2);
});

test("export dimensions fit the Word text area and keep proportions", () => {
	assert.deepEqual(fitImage(1344, 672), { width: 672, height: 336 });
	assert.deepEqual(fitImage(400, 1728), { width: 200, height: 864 });
	assert.deepEqual(fitImage(100, 50), { width: 100, height: 50 });
	for (const n of [0, -1, NaN, Infinity]) assert.throws(() => fitImage(n, 100), /invalid dimensions/);
});

test("by default the Word file is the script only", async () => {
	let reads = 0;
	const zip = await JSZip.loadAsync(await exportDocx(script(), settings, async () => { reads++; return png; }));
	assert.equal(reads, 0);
	assert.deepEqual(media(zip), []);
	const xml = await documentXml(zip);
	assert.match(xml, /Wide shot of the lighthouse\./);
	assert.doesNotMatch(xml, /VISUAL REFERENCES|Panel one\.png|<w:drawing>/);
});

test("the appendix follows the script, with each image under its page/panel and line", async () => {
	const doc = script();
	doc.pages[0].panels[0].blocks[0].image!.hidden = true; // hidden in the editor still exports
	const zip = await JSZip.loadAsync(await exportDocx(doc, { ...settings, exportReferences: true }, async (path) => {
		assert.equal(path, "Art/Panel one.png");
		return png;
	}));
	assert.equal(media(zip).length, 1);
	const xml = await documentXml(zip);
	const appendix = xml.indexOf("VISUAL REFERENCES");
	assert.ok(appendix > xml.indexOf("Wide shot of the lighthouse."), "appendix follows the script");
	const tail = xml.slice(appendix);
	assert.match(tail, /PAGE ONE, Panel 1/);
	assert.match(tail, /<w:drawing>/);
	assert.match(tail, /descr="A lighthouse in a storm"/);
	assert.match(tail, /Wide shot of the lighthouse\./);
	assert.doesNotMatch(xml.slice(0, appendix), /<w:drawing>/);
	assert.equal(panelsWithImages(doc).length, 1);
});

test("no appendix when no block has an image", async () => {
	const zip = await JSZip.loadAsync(await exportDocx(newDoc(settings, "Plain"), { ...settings, exportReferences: true }));
	assert.doesNotMatch(await documentXml(zip), /VISUAL REFERENCES/);
});

test("a reused attachment is read once and shown for every block", async () => {
	const doc = script();
	const second = newPanel(settings);
	second.blocks[0].image = { path: "Art/Panel one.png", alt: "", hidden: false };
	doc.pages[0].panels.push(second);
	let reads = 0;
	const zip = await JSZip.loadAsync(await exportDocx(doc, { ...settings, exportReferences: true }, async () => { reads++; return png; }));
	assert.equal(reads, 1);
	const xml = await documentXml(zip);
	assert.equal(xml.match(/<w:drawing>/g)!.length, 2);
	assert.match(xml, /descr="Panel one\.png"/, "file name stands in for missing alt text");
});

test("export fails clearly when an attachment can't be read", async () => {
	const on = { ...settings, exportReferences: true };
	await assert.rejects(exportDocx(script(), on), /needs a vault image loader/);
	await assert.rejects(exportDocx(script(), on, () => Promise.reject(new Error("Image missing"))), /Image missing/);
	await assert.rejects(exportDocx(script(), on, () => Promise.resolve({ ...png, width: 0 })), /invalid dimensions/);
});
