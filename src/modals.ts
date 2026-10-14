import { App, Modal, Setting } from "obsidian";
import { uid } from "./doc";
import { BlockStyle, BlockType } from "./types";

/** Creates or edits a block type ("Dialogue", "SFX", "Flashback caption", ...). */
export class BlockTypeModal extends Modal {
	private draft: BlockType;

	constructor(app: App, existing: BlockType | null, private onSave: (type: BlockType) => void) {
		super(app);
		this.draft = existing
			? { ...existing }
			: { id: uid(), name: "", color: "#e11d48", style: "lettering", numbered: true, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" };
	}

	onOpen() {
		this.titleEl.setText(this.draft.name ? `Edit block: ${this.draft.name}` : "New block type");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const d = this.draft;

		new Setting(contentEl).setName("Name").addText((t) =>
			t.setPlaceholder("For example: radio chatter").setValue(d.name).onChange((v) => (d.name = v))
		);
		new Setting(contentEl).setName("Colour").addColorPicker((c) => c.setValue(d.color).onChange((v) => (d.color = v)));
		new Setting(contentEl)
			.setName("Layout")
			.setDesc("Description is prose, like a panel description. Lettering has a speaker and a numbered line, like dialogue. Freestyle is anything, with its own alignment, indent, size and box.")
			.addDropdown((dd) =>
				dd
					.addOptions({ description: "Description", lettering: "Lettering (speaker + text)", freestyle: "Freestyle (anything, your own layout)" })
					.setValue(d.style)
					.onChange((v) => {
						d.style = v as BlockStyle;
						this.render();
					})
			);
		if (d.style === "lettering") {
			new Setting(contentEl)
				.setName("Numbered balloon")
				.setDesc("Counts toward the numbered lettering in each panel or page.")
				.addToggle((t) => t.setValue(d.numbered).onChange((v) => (d.numbered = v)));
			new Setting(contentEl)
				.setName("Default speaker")
				.setDesc("Pre-filled speaker, such as CAPTION, SFX or RADIO.")
				.addText((t) => t.setValue(d.defaultSpeaker).onChange((v) => (d.defaultSpeaker = v.toUpperCase())));
			new Setting(contentEl)
				.setName("Fixed speaker")
				.setDesc("Always use the default speaker and hide the speaker field.")
				.addToggle((t) => t.setValue(d.fixedSpeaker).onChange((v) => (d.fixedSpeaker = v)));
		}
		new Setting(contentEl)
			.setName("Default text")
			.setDesc("Text pre-filled in every new block of this type.")
			.addTextArea((t) => t.setValue(d.defaultText).onChange((v) => (d.defaultText = v)));

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					if (!d.name.trim()) d.name = "Untitled block";
					this.onSave({ ...d, name: d.name.trim() });
					this.close();
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Single-line text prompt. */
export class PromptModal extends Modal {
	constructor(app: App, private title: string, private initial: string, private onSubmit: (value: string) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		let value = this.initial;
		const submit = () => {
			if (value.trim()) this.onSubmit(value.trim());
			this.close();
		};
		new Setting(this.contentEl).addText((t) => {
			t.setValue(value).onChange((v) => (value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Yes/no confirmation for destructive actions that undo can't reverse (settings changes). */
export class ConfirmModal extends Modal {
	constructor(app: App, private title: string, private message: string, private confirmText: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.buttonEl.addClass("mod-warning");
				b
					.setButtonText(this.confirmText)
					.onClick(() => {
						this.onConfirm();
						this.close();
					});
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export type HelpTab = "start" | "shortcuts" | "tips";

/**
 * Help centre behind the "?" button: a short walkthrough for first use, every shortcut,
 * and the features that are easy to miss, so nothing has to be memorised to be found.
 */
export class HelpModal extends Modal {
	constructor(app: App, private tab: HelpTab = "start") {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Storyteller help");
		this.modalEl.addClass("st-help-modal");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const tabs = contentEl.createDiv({ cls: "st-help-tabs", attr: { role: "tablist" } });
		const items: [HelpTab, string][] = [
			["start", "Getting started"],
			["shortcuts", "Shortcuts"],
			["tips", "Tips"],
		];
		for (const [id, label] of items) {
			const b = tabs.createEl("button", { cls: "st-help-tab", text: label, attr: { role: "tab", "aria-selected": String(this.tab === id) } });
			b.toggleClass("is-active", this.tab === id);
			b.addEventListener("click", () => {
				this.tab = id;
				this.render();
			});
		}
		const body = contentEl.createDiv("st-help-body");
		if (this.tab === "start") this.renderStart(body);
		else if (this.tab === "shortcuts") this.renderShortcuts(body);
		else this.renderTips(body);
	}

	private renderStart(el: HTMLElement) {
		const steps: [string, string][] = [
			["Write a panel", "Each page starts with panels. Type the description right after “Panel 1:”. Add lettering with the + Dialogue / + Caption / + SFX buttons under a panel (hover to see them), or drag blocks in from the palette on the left."],
			["Name the speaker", "In a dialogue block, type the character's name, with an optional modifier in brackets, for example MAYA (off). Names you've used before autocomplete. Balloon numbers and page and panel numbers fill themselves in."],
			["Rearrange", "Hover over anything and drag its ⠿ grip to move it, even into another page. Numbers update automatically. Ctrl+Z undoes any change."],
			["Right-click for more", "Right-click a page, panel or block to comment on it, pin it, lock it, mark it for revision, duplicate it or delete it."],
			["Comment on words", "Select some words and click the comment button on the formatting bar (or press Ctrl+Alt+M). The comment sits beside just those words, as in Word, and follows them as you edit. Click a comment to reply to it."],
			["Format text", "Select some text and use the small bar that appears, or press Ctrl+B, Ctrl+I, Ctrl+U or Ctrl+Shift+H. The highlighter button opens a colour picker, just like Word's — only the selected words get coloured, not the whole block."],
			["Review", "Click Read in the top-left (or press Ctrl+E) to see the clean script as it will print. Double-click any line to go back and edit it."],
			["Export", "Click Export .docx. The Word file is saved in the “Exported” folder of your vault, ready for final edits in Word."],
		];
		const ol = el.createEl("ol", { cls: "st-help-steps" });
		for (const [title, text] of steps) {
			const li = ol.createEl("li");
			li.createDiv({ cls: "st-help-step-title", text: title });
			li.createDiv({ cls: "st-help-step-text", text });
		}
	}

	private renderTips(el: HTMLElement) {
		const tips: [string, string][] = [
			["Freestyle blocks", "For anything that isn't a description or dialogue: title cards, TO BE CONTINUED, notes to the colorist, lists. Click into one for its toolbar (align, indent, size, box), or right-click \u2192 Freestyle format. Bold, italic and the rest work inside it as usual."],
			["Your own blocks", "Use + New block type in the palette for anything you need, such as RADIO, FLASHBACK CAPTION or EDITOR'S NOTE. Right-click a finished block and choose “Save as reusable block” to keep it, text included."],
			["Palette sections", "Group blocks however you like with + New section, and drag blocks between sections. Drag a block from the script into a section to save it there."],
			["Edit blocks in the palette", "Drag the palette's right edge wider and every block becomes an editor for its name, colour, speaker and default text."],
			["Comments", "Right-click → Note or comment opens a card beside the page, as in Google Docs. Resolve it with ✓; the toolbar's comment button can show resolved ones again."],
			["Link notes in comments", "Type [[ in a comment (or click the link button) to pick a note from your vault. Posted links open the note; Ctrl+click opens it in a new tab and Ctrl+hover shows a preview. Links to notes that don't exist yet appear faded, and clicking one creates the note."],
			["Pinned & revisions", "The panel button at the top-right lists everything you've pinned or marked for revision. Click an item to jump to it."],
			["Dark or light paper", "The sun/moon button flips the paper. Right-click it for Auto, which follows Obsidian's theme."],
			["Spelling", "Shift+right-click inside text for the normal menu with spelling suggestions and paste."],
			["Oops", "Deleted something? Click Undo in the message that appears, or press Ctrl+Z (press Esc first if you're inside a text box)."],
			["Swap or move pages", "Right-click a page (its heading, or its entry in the Pages list) and choose \u201cSwap with page\u2026\u201d or \u201cMove to position\u2026\u201d. Pick the other page by clicking it or typing its number. No long drags needed."],
			["Lots of pages", "Use the Pages list on the left: click a page to jump to it, drag pages there to reorder them, or type a number in \u201cGo to page\u201d. The \u00ab button collapses it to a slim rail of numbers. A red dot means the page needs revision; an amber dot means it has open comments. Alt+PageUp / Alt+PageDown step between pages."],
		];
		for (const [title, text] of tips) {
			const row = el.createDiv("st-help-tip");
			row.createDiv({ cls: "st-help-step-title", text: title });
			row.createDiv({ cls: "st-help-step-text", text });
		}
	}

	private renderShortcuts(el: HTMLElement) {
		const groups: [string, [string, string][]][] = [
			[
				"Formatting (on the selected words, or on what you type next; or use the bar that pops up)",
				[
					["Ctrl+B", "Bold"],
					["Ctrl+I", "Italic"],
					["Ctrl+B then Ctrl+I", "Bold italic (the template's emphasis)"],
					["Ctrl+U", "Underline"],
					["Ctrl+Shift+H", "Highlight the selected words (yellow); click the toolbar button for other colours"],
					["Ctrl+Alt+M", "Comment on the selected words"],
				],
			],
			[
				"Writing",
				[
					["Ctrl+Enter", "New block of the same type below"],
					["Ctrl+Shift+Enter", "New panel below"],
					["↑ / ↓", "Move between fields (at the start or end of a field)"],
					["Enter (in title / byline)", "Go to the next line"],
					["Alt+↑ / Alt+↓", "Move the current block up or down"],
					["Esc", "Leave the field"],
					["MAYA (off)", "Type a modifier in brackets after the speaker"],
				],
			],
			[
				"Structure",
				[
					["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo (outside a field)"],
					["Right-click", "Comment, pin, lock, revise, move, delete…"],
					["Drag the ⠿ grip", "Move pages, panels and blocks"],
					["Double-click a heading", "Collapse or expand it"],
					["Shift+right-click", "Normal text menu (spelling, paste)"],
				],
			],
			[
				"Palette & view",
				[
					["Click / Enter on a chip", "Add it to the current panel"],
					["Drag the palette edge", "Wider palette = edit blocks in place"],
					["Sun/moon button", "Light or dark paper (right-click for Auto)"],
					["Ctrl+E", "Switch between Edit and Read mode"],
					["Alt+PageUp / Alt+PageDown", "Previous / next page"],
					["Double-click (in Read mode)", "Edit that line"],
					["? / Ctrl+/", "Open this help"],
				],
			],
		];
		for (const [title, rows] of groups) {
			el.createEl("h4", { text: title });
			const table = el.createEl("table", { cls: "st-shortcuts" });
			for (const [keys, what] of rows) {
				const tr = table.createEl("tr");
				const kd = tr.createEl("td");
				keys.split(" / ").forEach((k, i) => {
					if (i) kd.appendText(" / ");
					kd.createEl("kbd", { text: k });
				});
				tr.createEl("td", { text: what });
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export interface PageChoice {
	index: number;
	label: string;
	detail: string;
	/** Why this page can't be picked (shown greyed out), e.g. "this page" or "locked". */
	disabled?: string;
}

/**
 * Pick a page from a filterable list: type a number or words from the page,
 * use ↑/↓ and Enter, or click. Used for "Swap with page…" and "Move to position…".
 */
export class PagePickerModal extends Modal {
	private query = "";
	private selected = 0;
	private shown: PageChoice[] = [];
	private listEl: HTMLElement;

	constructor(app: App, private title: string, private choices: PageChoice[], private onChoose: (index: number) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.modalEl.addClass("st-picker-modal");
		const input = this.contentEl.createEl("input", {
			cls: "st-picker-input",
			attr: { type: "text", placeholder: "Type a page number or words from the page…", "aria-label": "Filter pages" },
		});
		this.listEl = this.contentEl.createDiv({ cls: "st-picker-list", attr: { role: "listbox" } });
		this.contentEl.createDiv({ cls: "st-picker-hint", text: "↑↓ to move · Enter to choose · Esc to cancel" });
		input.addEventListener("input", () => {
			this.query = input.value.trim().toLowerCase();
			this.selected = 0;
			this.renderList();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				this.move(e.key === "ArrowDown" ? 1 : -1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				this.choose(this.shown[this.selected]);
			}
		});
		this.renderList();
		window.setTimeout(() => input.focus(), 0);
	}

	private filtered(): PageChoice[] {
		const q = this.query;
		if (!q) return this.choices;
		if (/^\d+$/.test(q)) {
			// Numbers: the exact page first, then pages whose number starts with it.
			const n = parseInt(q, 10);
			const exact = this.choices.filter((c) => c.index + 1 === n);
			const rest = this.choices.filter((c) => c.index + 1 !== n && String(c.index + 1).startsWith(q));
			return [...exact, ...rest];
		}
		return this.choices.filter((c) => (c.label + " " + c.detail).toLowerCase().includes(q));
	}

	private renderList() {
		this.shown = this.filtered();
		// Start on the first page that can actually be chosen.
		if (this.shown[this.selected]?.disabled) {
			const i = this.shown.findIndex((c) => !c.disabled);
			this.selected = i < 0 ? 0 : i;
		}
		this.listEl.empty();
		if (!this.shown.length) {
			this.listEl.createDiv({ cls: "st-picker-empty", text: "No matching pages." });
			return;
		}
		this.shown.forEach((c, i) => {
			const row = this.listEl.createDiv({ cls: "st-picker-row", attr: { role: "option", "aria-selected": String(i === this.selected) } });
			row.toggleClass("is-selected", i === this.selected);
			row.toggleClass("is-disabled", !!c.disabled);
			row.createDiv({ cls: "st-picker-num", text: String(c.index + 1) });
			const text = row.createDiv("st-picker-text");
			text.createDiv({ cls: "st-picker-label", text: c.label + (c.disabled ? ` (${c.disabled})` : "") });
			if (c.detail) text.createDiv({ cls: "st-picker-detail", text: c.detail });
			row.addEventListener("mousemove", () => {
				if (this.selected !== i && !c.disabled) {
					this.selected = i;
					this.listEl.querySelectorAll(".st-picker-row").forEach((r, j) => r.toggleClass("is-selected", j === i));
				}
			});
			row.addEventListener("click", () => this.choose(c));
		});
		this.listEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
	}

	private move(dir: 1 | -1) {
		if (!this.shown.length) return;
		let i = this.selected;
		for (let n = 0; n < this.shown.length; n++) {
			i = (i + dir + this.shown.length) % this.shown.length;
			if (!this.shown[i].disabled) break;
		}
		this.selected = i;
		this.renderList();
	}

	private choose(c: PageChoice | undefined) {
		if (!c || c.disabled) return;
		this.close();
		this.onChoose(c.index);
	}

	onClose() {
		this.contentEl.empty();
	}
}
