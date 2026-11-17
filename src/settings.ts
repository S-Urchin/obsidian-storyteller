import { App, PluginSettingTab, requireApiVersion, Setting, SettingDefinition, SettingDefinitionItem } from "obsidian";
import type StorytellerPlugin from "./main";
import { DEFAULT_BLOCK_TYPES, DEFAULT_SETTINGS } from "./defaults";
import { browseForFolder, canBrowseFolders, cleanFolder, isSystemPath, vaultFolders } from "./locations";
import { BlockTypeModal } from "./modals";
import { BalloonScope, BlockType, PageNumberStyle, PaperMode, StorytellerSettings } from "./types";

/** A folder list in the settings: export folders (may be on the computer) or script folders (vault only). */
interface FolderList {
	id: string;
	name: string;
	desc: string;
	list: string[];
	placeholder: string;
	allowSystem: boolean;
}

type ExportToggle = "exportComments" | "exportRevisionMarks" | "exportHighlights" | "exportReferences" | "exportPageBreaks" | "openAfterExport";

const TEXT = {
	blockTypes: "These appear in the palette; star one there to show it under each panel too. Existing blocks keep working if you rename a type.",
	noPresets: "None yet. Right-click a block and choose save as reusable block.",
	newPanelBlocks: "Added automatically, in this order, every time you create a panel.",
	balloons: "Numbering for lettering blocks (1., 2., 3.).",
	font: "CSS font stack for the editor. Uses Courier Final Draft or Courier Prime when installed.",
	paper: "Auto uses dark paper when Obsidian's dark theme is on, and white paper otherwise. The toolbar's sun/moon button switches it too.",
	animations: "Smooth movement when you add, move, collapse or delete things. Always off if your system has reduced motion turned on.",
	name: "Shown as the author of comments, in exported files, and in the byline of new scripts.",
	wordFont: "Font name written into the .docx. The Greg Pak template uses Courier Final Draft; Courier New is on every computer.",
};

const EXPORT_TOGGLES: [string, string, ExportToggle][] = [
	["Comments", "Unresolved comments become Word margin comments.", "exportComments"],
	["Revision markers", "Prefix items marked for revision with a red [REVISE].", "exportRevisionMarks"],
	["Highlights", "Carry ==marked text== highlights into Word.", "exportHighlights"],
	["Visual references appendix", "After the script, add a page with each block's reference image, under its page and panel. The script itself never contains images.", "exportReferences"],
	["Page break per page", "Start every comic page on a new Word page.", "exportPageBreaks"],
];
const OPEN_AFTER: [string, string, ExportToggle] = ["Open after export", "Open the exported .docx in your computer's default app (for example Word) as soon as it's saved.", "openAfterExport"];

const PAGE_NUMBERS: Record<PageNumberStyle, string> = { words: "PAGE ONE", digits: "PAGE 1" };
const BALLOONS: Record<BalloonScope, string> = { page: "Restart each page", panel: "Restart each panel", off: "Off" };
const PAPER: Record<PaperMode, string> = { auto: "Auto (match Obsidian)", light: "Light paper", dark: "Dark paper" };
/** Text settings that fall back to their default when cleared. */
const FALLBACKS: Partial<Record<keyof StorytellerSettings, string>> = { fontFamily: DEFAULT_SETTINGS.fontFamily, exportFont: DEFAULT_SETTINGS.exportFont };

/**
 * Obsidian 1.13+ builds this tab from getSettingDefinitions(), which also makes every setting
 * findable in the settings search. Older versions call display() and get the same rows.
 */
export class StorytellerSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: StorytellerPlugin) {
		super(app, plugin);
	}

	private get s(): StorytellerSettings {
		return this.plugin.settings;
	}

	/** Saves; `structural` redraws the tab (rows were added, removed or reordered). */
	private save = async (structural = false) => {
		await this.plugin.saveSettings();
		if (!structural) return;
		// 1.13+ rebuilds the tab from getSettingDefinitions(); older versions redraw it by hand.
		if (requireApiVersion("1.13.0")) this.update();
		else this.render();
	};

	private exportFolders(): FolderList {
		return {
			id: "export",
			name: "Export folders",
			desc: "Where .docx files are saved. The Export .docx button saves to the one you picked last; the arrow next to it lists them all. Use a vault folder (Exported, Comics/Drafts), leave a row empty to save next to the script, or, in the desktop app, a full path on your computer (C:\\Users\\you\\Documents or ~/Desktop). Folders are created on first use.",
			list: this.s.exportFolders,
			placeholder: "Next to the script",
			allowSystem: true,
		};
	}

	private scriptFolders(): FolderList {
		return {
			id: "scripts",
			name: "Script folders",
			desc: "Vault folders new .comic scripts can be created in. With none, new scripts go in the current folder; with more than one, you're asked which to use. Right-clicking a folder always creates the script there.",
			list: this.s.scriptFolders,
			placeholder: "Vault root",
			allowSystem: false,
		};
	}

	// ---------------------------------------------------------------- Obsidian 1.13+

	getControlValue(key: string): unknown {
		return (this.s as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const fallback = FALLBACKS[key as keyof StorytellerSettings];
		const v = fallback !== undefined && typeof value === "string" ? value.trim() || fallback : value;
		(this.s as unknown as Record<string, unknown>)[key] = v;
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.s;
		const toggle = ([name, desc, key]: [string, string, ExportToggle]): SettingDefinition => ({ name, desc, control: { type: "toggle", key } });
		const folders = (o: FolderList): SettingDefinition[] => [
			{ name: o.name, desc: o.desc, render: (row) => this.folderHeader(row, o) },
			...o.list.map((folder, i): SettingDefinition => ({
				name: folder || o.placeholder,
				searchable: false,
				render: (row) => this.folderRow(row, o, i),
			})),
			{ name: `Add ${o.name.toLowerCase().replace(/s$/, "")}`, searchable: false, render: (row) => this.folderAdd(row, o) },
		];
		return [
			{
				type: "group",
				heading: "Block types",
				items: [
					{ name: "Your block types", desc: TEXT.blockTypes, aliases: ["palette", "dialogue", "caption", "SFX"] },
					...s.blockTypes.map((type, i): SettingDefinition => ({
						name: type.name,
						desc: this.typeDesc(type),
						aliases: ["block type"],
						render: (row) => this.blockTypeRow(row, type, i),
					})),
					{ name: "Add or restore block types", searchable: false, render: (row) => this.blockTypeButtons(row) },
				],
			},
			{
				type: "group",
				heading: "Saved blocks",
				items: s.presets.length
					? s.presets.map((p, i): SettingDefinition => ({ name: p.name, desc: this.presetDesc(p), aliases: ["saved block", "reusable block"], render: (row) => this.presetRow(row, i) }))
					: [{ name: "No saved blocks", desc: TEXT.noPresets, aliases: ["saved block", "reusable block"] }],
			},
			{
				type: "group",
				heading: "New pages and panels",
				items: [
					{ name: "Panels on a new page", control: { type: "slider", key: "newPagePanels", min: 0, max: 9, step: 1 } },
					{ name: "Blocks in a new panel", desc: TEXT.newPanelBlocks, render: (row) => this.newPanelBlocks(row) },
				],
			},
			{
				type: "group",
				heading: "Numbering",
				items: [
					{ name: "Page numbers", control: { type: "dropdown", key: "pageNumberStyle", options: PAGE_NUMBERS } },
					{ name: "Balloon numbers", desc: TEXT.balloons, control: { type: "dropdown", key: "balloonScope", options: BALLOONS } },
				],
			},
			{
				type: "group",
				heading: "Editor appearance",
				items: [
					{ name: "Draft font", desc: TEXT.font, control: { type: "text", key: "fontFamily" } },
					{ name: "Font size", control: { type: "slider", key: "fontSize", min: 11, max: 24, step: 1 } },
					{ name: "Paper style", desc: TEXT.paper, aliases: ["dark", "light", "theme"], control: { type: "dropdown", key: "paperMode", options: PAPER } },
					{ name: "Animations", desc: TEXT.animations, control: { type: "toggle", key: "animations" } },
					{ name: "Your name", desc: TEXT.name, aliases: ["author"], control: { type: "text", key: "authorName" } },
				],
			},
			{
				type: "group",
				heading: "Word export",
				items: [
					...EXPORT_TOGGLES.map(toggle),
					{ name: "Word font", desc: TEXT.wordFont, control: { type: "text", key: "exportFont" } },
					toggle(OPEN_AFTER),
					...folders(this.exportFolders()),
				],
			},
			{ type: "group", heading: "New scripts", items: folders(this.scriptFolders()) },
		];
	}

	// ---------------------------------------------------------------- Obsidian before 1.13

	display(): void {
		this.render();
	}

	private render(): void {
		const { containerEl } = this;
		const s = this.s;
		const row = () => new Setting(containerEl);
		const heading = (name: string) => new Setting(containerEl).setName(name).setHeading();
		const note = (text: string) => containerEl.createEl("p", { cls: "setting-item-description", text });
		containerEl.empty();

		heading("Block types");
		note(TEXT.blockTypes);
		s.blockTypes.forEach((type, i) => this.blockTypeRow(row().setName(type.name).setDesc(this.typeDesc(type)), type, i));
		this.blockTypeButtons(row());

		heading("Saved blocks");
		if (!s.presets.length) note(TEXT.noPresets);
		s.presets.forEach((p, i) => this.presetRow(row().setName(p.name).setDesc(this.presetDesc(p)), i));

		heading("New pages and panels");
		row().setName("Panels on a new page").addSlider((sl) => sl.setLimits(0, 9, 1).setValue(s.newPagePanels).onChange((v) => void this.setControlValue("newPagePanels", v)));
		this.newPanelBlocks(row().setName("Blocks in a new panel").setDesc(TEXT.newPanelBlocks));

		heading("Numbering");
		row().setName("Page numbers").addDropdown((d) => d.addOptions(PAGE_NUMBERS).setValue(s.pageNumberStyle).onChange((v) => void this.setControlValue("pageNumberStyle", v)));
		row().setName("Balloon numbers").setDesc(TEXT.balloons).addDropdown((d) => d.addOptions(BALLOONS).setValue(s.balloonScope).onChange((v) => void this.setControlValue("balloonScope", v)));

		heading("Editor appearance");
		row().setName("Draft font").setDesc(TEXT.font).addText((t) => t.setValue(s.fontFamily).onChange((v) => void this.setControlValue("fontFamily", v)));
		row().setName("Font size").addSlider((sl) => sl.setLimits(11, 24, 1).setValue(s.fontSize).onChange((v) => void this.setControlValue("fontSize", v)));
		row().setName("Paper style").setDesc(TEXT.paper).addDropdown((d) => d.addOptions(PAPER).setValue(s.paperMode).onChange((v) => void this.setControlValue("paperMode", v)));
		row().setName("Animations").setDesc(TEXT.animations).addToggle((t) => t.setValue(s.animations).onChange((v) => void this.setControlValue("animations", v)));
		row().setName("Your name").setDesc(TEXT.name).addText((t) => t.setValue(s.authorName).onChange((v) => void this.setControlValue("authorName", v)));

		heading("Word export");
		const toggle = ([name, desc, key]: [string, string, ExportToggle]) =>
			row().setName(name).setDesc(desc).addToggle((t) => t.setValue(s[key]).onChange((v) => void this.setControlValue(key, v)));
		for (const t of EXPORT_TOGGLES) toggle(t);
		row().setName("Word font").setDesc(TEXT.wordFont).addText((t) => t.setValue(s.exportFont).onChange((v) => void this.setControlValue("exportFont", v)));
		toggle(OPEN_AFTER);
		this.folderListRows(this.exportFolders());

		heading("New scripts");
		this.folderListRows(this.scriptFolders());
	}

	private folderListRows(o: FolderList) {
		const row = () => new Setting(this.containerEl);
		this.folderHeader(row().setName(o.name).setDesc(o.desc), o);
		o.list.forEach((_, i) => this.folderRow(row(), o, i));
		this.folderAdd(row(), o);
	}

	// ---------------------------------------------------------------- rows shared by both

	private typeDesc(type: BlockType): string {
		if (type.style === "lettering") return `Lettering${type.numbered ? ", numbered" : ""}${type.defaultSpeaker ? `, speaker ${type.defaultSpeaker}` : ""}`;
		return type.style === "freestyle" ? "Freestyle" : "Description";
	}

	private presetDesc(p: { speaker: string; text: string }): string {
		return (p.speaker ? p.speaker + ": " : "") + p.text.slice(0, 80);
	}

	private blockTypeRow(row: Setting, type: BlockType, i: number) {
		const s = this.s;
		const swatch = row.nameEl.createSpan({ cls: "st-settings-swatch" });
		swatch.setCssStyles({ background: type.color });
		row.nameEl.prepend(swatch);
		row.addExtraButton((b) =>
			b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(async () => {
				s.blockTypes.splice(i - 1, 0, s.blockTypes.splice(i, 1)[0]);
				await this.save(true);
			})
		);
		row.addExtraButton((b) =>
			b.setIcon("arrow-down").setTooltip("Move down").setDisabled(i === s.blockTypes.length - 1).onClick(async () => {
				s.blockTypes.splice(i + 1, 0, s.blockTypes.splice(i, 1)[0]);
				await this.save(true);
			})
		);
		row.addExtraButton((b) =>
			b.setIcon("pencil").setTooltip("Edit").onClick(() =>
				new BlockTypeModal(this.app, type, (t) => {
					Object.assign(type, t);
					void this.save(true);
				}).open()
			)
		);
		row.addExtraButton((b) =>
			b.setIcon("trash").setTooltip("Delete").onClick(async () => {
				s.blockTypes.splice(i, 1);
				s.newPanelBlocks = s.newPanelBlocks.filter((id) => id !== type.id);
				await this.save(true);
			})
		);
	}

	private blockTypeButtons(row: Setting) {
		const s = this.s;
		row
			.addButton((b) =>
				b
					.setButtonText("Add block type")
					.setCta()
					.onClick(() =>
						new BlockTypeModal(this.app, null, (t) => {
							s.blockTypes.push(t);
							void this.save(true);
						}).open()
					)
			)
			.addButton((b) =>
				b.setButtonText("Restore default types").onClick(async () => {
					for (const def of DEFAULT_BLOCK_TYPES) if (!s.blockTypes.some((t) => t.id === def.id)) s.blockTypes.push({ ...def });
					await this.save(true);
				})
			);
	}

	private presetRow(row: Setting, i: number) {
		row.addExtraButton((b) =>
			b.setIcon("trash").setTooltip("Delete").onClick(async () => {
				this.s.presets.splice(i, 1);
				await this.save(true);
			})
		);
	}

	private newPanelBlocks(row: Setting) {
		const s = this.s;
		const list = row.controlEl.createDiv("st-settings-checks");
		for (const type of s.blockTypes) {
			const label = list.createEl("label");
			const cb = label.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = s.newPanelBlocks.includes(type.id);
			label.appendText(" " + type.name);
			cb.addEventListener("change", () => {
				s.newPanelBlocks = cb.checked ? [...s.newPanelBlocks, type.id] : s.newPanelBlocks.filter((id) => id !== type.id);
				void this.save();
			});
		}
	}

	/** The list's heading row also holds the autocomplete list of vault folders for its text boxes. */
	private folderHeader(row: Setting, o: FolderList) {
		const datalist = row.settingEl.createEl("datalist", { attr: { id: `st-vault-folders-${o.id}` } });
		for (const path of vaultFolders(this.app)) datalist.createEl("option", { attr: { value: path } });
	}

	private folderRow(row: Setting, o: FolderList, i: number) {
		row.setClass("st-folder-row");
		row.addText((t) => {
			t.setPlaceholder(o.placeholder).setValue(o.list[i]);
			t.inputEl.setAttr("list", `st-vault-folders-${o.id}`);
			t.inputEl.addClass("st-folder-input", `st-folder-input-${o.id}`);
			const warn = () => {
				const bad = !o.allowSystem && isSystemPath(cleanFolder(t.getValue()));
				t.inputEl.toggleClass("is-invalid", bad);
				t.inputEl.title = bad ? "New scripts must go in a vault folder." : "";
			};
			warn();
			t.onChange(async (v) => {
				o.list[i] = cleanFolder(v);
				warn();
				await this.save();
			});
		});
		row.addExtraButton((b) =>
			b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(async () => {
				o.list.splice(i - 1, 0, o.list.splice(i, 1)[0]);
				await this.save(true);
			})
		);
		row.addExtraButton((b) =>
			b.setIcon("trash").setTooltip("Remove").onClick(async () => {
				o.list.splice(i, 1);
				await this.save(true);
			})
		);
	}

	private folderAdd(row: Setting, o: FolderList) {
		row.addButton((b) =>
			b.setButtonText("Add vault folder").onClick(async () => {
				o.list.push(o.list.includes("") ? "New folder" : "");
				await this.save(true);
				// Put the cursor in the new row so it can be typed straight away.
				window.setTimeout(() => {
					const inputs = this.containerEl.querySelectorAll<HTMLInputElement>(`.st-folder-input-${o.id}`);
					inputs[inputs.length - 1]?.select();
				}, 0);
			})
		);
		if (o.allowSystem && canBrowseFolders()) {
			row.addButton((b) =>
				b.setButtonText("Browse computer…").onClick(async () => {
					const picked = await browseForFolder("Choose an export folder");
					if (!picked) return;
					o.list.push(picked);
					await this.save(true);
				})
			);
		}
	}
}
