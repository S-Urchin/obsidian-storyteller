// Isolated browser integration test: real image renderers, with the Obsidian host stubbed.
// Never opens or modifies a user vault. Set CHROME_PATH if Chrome is installed elsewhere.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { build } = require("esbuild");
const puppeteer = require("puppeteer-core");

const root = path.resolve(__dirname, "..", "..");
const host = `
export class TFile { constructor(path) { this.path = path; this.extension = path.split(".").pop(); this.basename = path; } }
export class TFolder {}
export class Scope { register() {} }
export class TextFileView {
	constructor(leaf) { this.app = leaf.app; this.contentEl = document.createElement("div"); }
	requestSave() {}
	async save() { this.saved = this.getViewData(); }
}
export class Modal {
	constructor(app) { this.app = app; this.modalEl = document.createElement("div"); this.titleEl = document.createElement("div"); this.contentEl = document.createElement("div"); }
	open() { window.openedModal = this; this.onOpen?.(); }
	close() {}
}
export class FuzzySuggestModal {
	constructor(app) { this.app = app; }
	setPlaceholder() {}
	open() { window.imagePicker = this; }
}
export class SuggestModal extends FuzzySuggestModal {}
export class Notice { constructor(message) { window.notices.push(message); } }
export class Menu {}
export class Setting {}
export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export const Platform = { isDesktop: true };
export const Keymap = {};
export function normalizePath(path) { return path; }
export function setIcon(el, icon) { el.dataset.icon = icon; }
`;

(async () => {
	const bundle = await build({
		stdin: {
			contents: `import { ComicView } from "./src/view"; import StorytellerPlugin from "./src/main"; import * as docModule from "./src/doc"; import * as images from "./src/images"; const doc = { ...docModule, ...images }; import { DEFAULT_SETTINGS } from "./src/defaults"; import { TFile } from "obsidian"; window.storyteller = { ComicView, StorytellerPlugin, doc, DEFAULT_SETTINGS, TFile };`,
			resolveDir: root,
		},
		bundle: true, write: false, format: "iife", platform: "browser",
		plugins: [{
			name: "obsidian-test-host",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-host" }));
				build.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ contents: host, loader: "js" }));
			},
		}],
	});
	const browser = await puppeteer.launch({
		executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		headless: true,
	});
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setContent("<!doctype html><html><body></body></html>");
		await page.addStyleTag({ content: fs.readFileSync(path.join(root, "styles.css"), "utf8") });
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const check = (condition, message) => { if (!condition) throw new Error(message); };
			// Obsidian extends the DOM with these helpers.
			Element.prototype.createEl = function(tag, options = {}) {
				if (typeof options === "string") options = { cls: options };
				const el = document.createElement(tag);
				if (options.cls) el.className = options.cls;
				if (options.text) el.textContent = options.text;
				for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
				this.appendChild(el);
				return el;
			};
			Element.prototype.createDiv = function(options) { return this.createEl("div", options); };
			Element.prototype.createSpan = function(options) { return this.createEl("span", options); };
			Element.prototype.empty = function() { this.replaceChildren(); };
			Element.prototype.setText = function(text) { this.textContent = text; };
			Element.prototype.appendText = function(text) { this.appendChild(document.createTextNode(text)); };
			Element.prototype.setAttr = function(key, value) { this.setAttribute(key, value); };
			Element.prototype.setAttrs = function(attrs) { for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value); };
			Element.prototype.addClass = function(...classes) { this.classList.add(...classes); };
			Element.prototype.removeClass = function(...classes) { this.classList.remove(...classes); };
			Element.prototype.hasClass = function(cls) { return this.classList.contains(cls); };
			Element.prototype.toggleClass = function(cls, on) { this.classList.toggle(cls, on); };
			Element.prototype.setCssProps = function(props) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); };
			Element.prototype.setCssStyles = function(styles) { Object.assign(this.style, styles); };
			Element.prototype.instanceOf = function(type) { return this instanceof type; };
			window.createSpan = (options) => {
				const parent = document.createElement("div");
				return parent.createSpan(options);
			};
			window.notices = [];
			window.createFragment = (fill) => { const f = document.createElement("div"); fill(f); return f; };
			const { ComicView, StorytellerPlugin, doc, DEFAULT_SETTINGS, TFile } = window.storyteller;
			const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
			settings.animations = false;
			const file = new TFile("Art/Panel one.png");
			const files = new Map([[file.path, file]]);
			const resource = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=";
			let resourcesRequested = 0;
			const app = {
				scope: {},
				vault: {
					getFiles: () => [...files.values()],
					getAbstractFileByPath: (path) => files.get(path),
					getResourcePath: () => { resourcesRequested++; return resource; },
				},
			};
			const plugin = { settings, exportFolders: () => [""], saveSettings: async () => {} };
			const view = new ComicView({ app }, plugin);
			document.body.appendChild(view.contentEl);
			view.contentEl.className = "st-root st-paper-light";
			// Keep the real toolbar, panel/block renderers, image column and rich text. Only omit unrelated navigation/margin layout.
			view.queueLayout = () => {};
			view.updateStats = () => {};
			view.renderAll = function() {
				this.destroyEditors();
				this.contentEl.empty();
				this.panelCountEls.clear();
				this.imageColEl = null;
				this.renderToolbar(this.contentEl.createDiv("st-toolbar"));
				this.scriptEl = this.contentEl.createDiv("st-script");
				if (this.readMode) this.renderRead();
				else {
					const canvas = this.scriptEl.createDiv("st-canvas");
					this.imageColEl = doc.docHasImages(this.doc) ? canvas.createDiv("st-image-col") : null;
					const sheet = canvas.createDiv("st-sheet");
					this.doc.pages.forEach((page, pi) => page.panels.forEach((panel, ni) => {
						this.renderPanel(sheet, page, pi, panel, ni, doc.balloonNumbers(this.doc, settings, settings.balloonScope));
					}));
					this.renderImageCol();
					this.layoutImageCol();
				}
			};
			const panel = view.doc.pages[0].panels[0];
			panel.blocks[0].text = "Wide shot of the lighthouse.";
			const line = doc.newBlock(doc.findType(settings, "dialogue"));
			line.text = "Not tonight.";
			panel.blocks.push(line);
			view.renderAll();
			const blockEl = (b) => view.scriptEl.querySelector(`.st-block[data-id="${b.id}"]`);
			const addBtn = (b) => blockEl(b).querySelector(":scope > .st-gutter .st-add-image");
			const card = () => view.contentEl.querySelector(".st-image-card");
			const sheet = () => view.scriptEl.querySelector(".st-sheet");
			const live = () => view.doc.pages[0].panels[0].blocks[1];

			check(!view.contentEl.querySelector(".st-image-col"), "no image column until a block has an image");
			check(addBtn(line) && addBtn(panel.blocks[0]), "every block has an add-image button in its left gutter");
			check(!settings.blockTypes.some((t) => t.style === "image"), "no Image block type");

			addBtn(line).click();
			check(window.imagePicker.getItems().length === 1, "picker lists only vault images");
			window.imagePicker.onChooseItem(file);
			check(live().image && live().image.path === file.path && !live().image.hidden, "choosing attaches the image to that block");
			check(!addBtn(live()), "one image per block: the add button goes");
			check(addBtn(view.doc.pages[0].panels[0].blocks[0]), "other blocks keep their add button");
			const col = view.contentEl.querySelector(".st-image-col");
			check(col && col.nextElementSibling === sheet(), "image column sits left of the paper");
			check(card() && card().querySelector(".st-image-thumb img"), "the image is thumbnailed");
			check(!sheet().querySelector("img"), "the paper itself never shows images");
			const cardTop = card().getBoundingClientRect().top, lineTop = blockEl(live()).getBoundingClientRect().top;
			check(Math.abs(cardTop - lineTop) < 2, `thumbnail is level with its block (${cardTop} vs ${lineTop})`);

			card().querySelector(".st-image-thumb").click();
			check(window.openedModal && window.openedModal.src === resource, "clicking the thumbnail enlarges it");
			window.openedModal = null;
			card().querySelector(".st-image-enlarge").click();
			check(window.openedModal && window.openedModal.src === resource, "the enlarge button enlarges it");

			card().dispatchEvent(new MouseEvent("mouseenter"));
			check(blockEl(live()).classList.contains("st-image-anchor"), "pointing at a thumbnail marks its block");
			card().dispatchEvent(new MouseEvent("mouseleave"));

			card().querySelector(".st-image-hide").click();
			check(live().image.hidden && card().classList.contains("is-hidden") && !card().querySelector("img"), "hide folds it to a small chip");
			check(card().getBoundingClientRect().height < 40, "a hidden image takes little room");
			check(JSON.parse(view.getViewData()).pages[0].panels[0].blocks[1].image.hidden === true, "hidden state is saved in the script");
			card().querySelector(".st-image-enlarge").click();
			check(window.openedModal, "a hidden image can still be enlarged");
			card().querySelector(".st-image-hide").click();
			check(!live().image.hidden && card().querySelector("img"), "show brings the thumbnail back");
			view.undo();
			check(live().image.hidden, "undo restores the hidden state");
			view.redo();

			// Locked: enlarge only.
			view.doc.pages[0].panels[0].locked = true;
			view.renderAll();
			check(card().querySelector(".st-image-enlarge") && !card().querySelector(".st-image-hide, .st-image-remove"), "locked block: enlarge only");
			check(!view.scriptEl.querySelector(".st-add-image"), "locked panel: no add buttons");
			view.doc.pages[0].panels[0].locked = false;
			view.renderAll();

			// Remove, then undo.
			card().querySelector(".st-image-remove").click();
			check(!live().image && !view.contentEl.querySelector(".st-image-col") && addBtn(live()), "remove takes the image off and brings the add button back");
			view.undo();
			check(live().image && card(), "undo restores the image");

			// Missing file is explicit.
			files.clear();
			view.renderAll();
			check(card().textContent.includes("Missing: Art/Panel one.png") && card().querySelector(".st-image-remove"), "missing attachment is explicit and removable");

			// Renames update the script and its history.
			const newPath = "Sketches/Renamed.png";
			files.set(newPath, new TFile(newPath));
			await view.renameImages(file.path, newPath);
			check(JSON.parse(view.saved).pages[0].panels[0].blocks[1].image.path === newPath, "attachment rename persists");
			check(card().querySelector("img"), "renamed image shows again");
			view.undo();
			check(live().image.path === newPath, "undo does not restore stale attachment paths");

			// Read mode is the clean script.
			view.readMode = true;
			view.renderAll();
			check(!view.contentEl.querySelector(".st-image-col, img, .st-add-image"), "Read mode has no images");
			check(view.scriptEl.textContent.includes("Not tonight."), "Read mode shows the script");
			view.readMode = false;
			view.renderAll();

			// Collapsed panel: no floating thumbnail with nothing to line up with.
			view.doc.pages[0].panels[0].collapsed = true;
			view.renderAll();
			check(!card(), "collapsed panel hides its thumbnails");
			view.doc.pages[0].panels[0].collapsed = false;

			// Reopening keeps the image.
			view.setViewData(view.getViewData(), true);
			check(card() && live().image.path === newPath, "image survives reopening");
			view.destroyEditors();

			// Settings migration from the image-block version (schema 9).
			const main = new StorytellerPlugin();
			const legacy = {
				...settings, schema: 9, exportImages: true,
				blockTypes: [...settings.blockTypes, { id: "image", name: "Image", color: "#eab308", style: "image", numbered: false, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" }],
				quickAdd: ["type:dialogue", "type:image"],
				presets: [
					{ id: "p1", name: "Sketch", typeId: "image", speaker: "", modifier: "", text: "", image: { path: "a.png", alt: "", hidden: false } },
					{ id: "p2", name: "Hi", typeId: "dialogue", speaker: "MAYA", modifier: "", text: "Hi" },
				],
				paletteSections: [{ id: "blocks", name: "Blocks", collapsed: false, items: ["type:image", "type:dialogue", "preset:p1", "preset:p2"] }],
			};
			delete legacy.exportReferences;
			main.loadData = async () => legacy;
			await main.loadSettings();
			check(!main.settings.blockTypes.some((t) => t.id === "image"), "migration removes the Image block type");
			check(main.settings.quickAdd.join(",") === "type:dialogue", "migration removes the Image star");
			check(main.settings.presets.map((p) => p.id).join(",") === "p2", "migration removes saved image blocks");
			check(!main.settings.paletteSections.some((s) => s.items.includes("type:image") || s.items.includes("preset:p1")), "migration cleans the palette");
			check(main.settings.exportReferences === true && !("exportImages" in main.settings), "the image export choice carries over");

			// Closed scripts follow renames too.
			main.loadData = async () => settings;
			await main.loadSettings();
			const closed = new TFile("Closed.comic");
			const other = new TFile("Other.comic");
			const closedDoc = doc.newDoc(settings, "Closed");
			closedDoc.pages[0].panels[0].blocks[0].image = { path: file.path, alt: "", hidden: false };
			const contents = new Map([
				[closed.path, JSON.stringify(closedDoc).replaceAll("Art/", "Art\\/")],
				[other.path, JSON.stringify(doc.newDoc(settings, "Unrelated"))],
			]);
			let writes = 0;
			main.saveData = async () => {};
			main.app = {
				workspace: { getLeavesOfType: () => [] },
				vault: {
					getFiles: () => [closed, other],
					read: async (f) => contents.get(f.path),
					process: async (f, change) => {
						writes++;
						const latest = JSON.parse(contents.get(f.path));
						latest.title = "Concurrent edit";
						contents.set(f.path, change(JSON.stringify(latest)));
					},
					getAbstractFileByPath: (path) => path === newPath ? new TFile(newPath) : null,
					readBinary: async () => (await fetch(resource)).arrayBuffer(),
				},
			};
			await main.renameImages(file.path, newPath);
			const updated = JSON.parse(contents.get(closed.path));
			check(writes === 1 && updated.title === "Concurrent edit", "closed-script rename keeps concurrent edits and skips unrelated files");
			check(updated.pages[0].panels[0].blocks[0].image.path === newPath, "closed-script rename handles escaped JSON paths");
			const exported = await main.loadExportImage(newPath);
			check(exported.type === "png" && exported.width === 1 && exported.height === 1 && exported.data.length > 0, "export reads and decodes vault image bytes");
			try {
				await main.loadExportImage("Missing.png");
				throw new Error("missing export image unexpectedly succeeded");
			} catch (error) {
				check(error.message.includes("Image missing"), "missing export image fails explicitly");
			}
			return "Block images: add from the gutter, one per block, thumbnail column, enlarge (click + button), hide/show, lock, remove/undo, missing files, renames, read mode, collapse, reopen and settings migration passed.";
		});
		assert.deepEqual(errors, []);
		console.log(result);
	} finally {
		await browser.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
