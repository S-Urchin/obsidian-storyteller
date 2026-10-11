import { App, PluginSettingTab, Setting } from "obsidian";
import type StorytellerPlugin from "./main";
import { DEFAULT_BLOCK_TYPES, DEFAULT_SETTINGS } from "./defaults";
import { BlockTypeModal } from "./modals";
import { BalloonScope, PageNumberStyle, PaperMode } from "./types";

export class StorytellerSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: StorytellerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = async (rerender = false) => {
			await this.plugin.saveSettings();
			if (rerender) this.display();
		};
		containerEl.empty();

		// ---- Block types
		new Setting(containerEl).setName("Block types").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "These appear in the palette and in each panel's quick-add row. Existing blocks keep working if you rename a type.",
		});
		s.blockTypes.forEach((type, i) => {
			const row = new Setting(containerEl).setName(type.name).setDesc(
				type.style === "lettering"
					? `Lettering${type.numbered ? ", numbered" : ""}${type.defaultSpeaker ? `, speaker ${type.defaultSpeaker}` : ""}`
					: type.style === "freestyle"
					? "Freestyle"
					: "Description"
			);
			const swatch = row.nameEl.createSpan({ cls: "st-settings-swatch" });
			swatch.style.background = type.color;
			row.nameEl.prepend(swatch);
			row.addExtraButton((b) =>
				b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(async () => {
					s.blockTypes.splice(i - 1, 0, s.blockTypes.splice(i, 1)[0]);
					await save(true);
				})
			);
			row.addExtraButton((b) =>
				b.setIcon("arrow-down").setTooltip("Move down").setDisabled(i === s.blockTypes.length - 1).onClick(async () => {
					s.blockTypes.splice(i + 1, 0, s.blockTypes.splice(i, 1)[0]);
					await save(true);
				})
			);
			row.addExtraButton((b) =>
				b.setIcon("pencil").setTooltip("Edit").onClick(() =>
					new BlockTypeModal(this.app, type, async (t) => {
						Object.assign(type, t);
						await save(true);
					}).open()
				)
			);
			row.addExtraButton((b) =>
				b.setIcon("trash").setTooltip("Delete").onClick(async () => {
					s.blockTypes.splice(i, 1);
					s.newPanelBlocks = s.newPanelBlocks.filter((id) => id !== type.id);
					await save(true);
				})
			);
		});
		new Setting(containerEl)
			.addButton((b) =>
				b
					.setButtonText("Add block type")
					.setCta()
					.onClick(() =>
						new BlockTypeModal(this.app, null, async (t) => {
							s.blockTypes.push(t);
							await save(true);
						}).open()
					)
			)
			.addButton((b) =>
				b.setButtonText("Restore default types").onClick(async () => {
					for (const def of DEFAULT_BLOCK_TYPES) if (!s.blockTypes.some((t) => t.id === def.id)) s.blockTypes.push({ ...def });
					await save(true);
				})
			);

		// ---- Saved blocks
		new Setting(containerEl).setName("Saved blocks").setHeading();
		if (!s.presets.length) {
			containerEl.createEl("p", { cls: "setting-item-description", text: "None yet. Right-click a block and choose “Save as reusable block”." });
		}
		s.presets.forEach((p, i) => {
			new Setting(containerEl)
				.setName(p.name)
				.setDesc((p.speaker ? p.speaker + ": " : "") + p.text.slice(0, 80))
				.addExtraButton((b) =>
					b.setIcon("trash").setTooltip("Delete").onClick(async () => {
						s.presets.splice(i, 1);
						await save(true);
					})
				);
		});

		// ---- New pages and panels
		new Setting(containerEl).setName("New pages and panels").setHeading();
		new Setting(containerEl)
			.setName("Panels on a new page")
			.addSlider((sl) => sl.setLimits(0, 9, 1).setValue(s.newPagePanels).setDynamicTooltip().onChange(async (v) => {
				s.newPagePanels = v;
				await save();
			}));
		const blocksSetting = new Setting(containerEl)
			.setName("Blocks in a new panel")
			.setDesc("Added automatically, in this order, every time you create a panel.");
		const list = blocksSetting.controlEl.createDiv("st-settings-checks");
		for (const type of s.blockTypes) {
			const label = list.createEl("label");
			const cb = label.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = s.newPanelBlocks.includes(type.id);
			label.appendText(" " + type.name);
			cb.addEventListener("change", async () => {
				s.newPanelBlocks = cb.checked ? [...s.newPanelBlocks, type.id] : s.newPanelBlocks.filter((id) => id !== type.id);
				await save();
			});
		}

		// ---- Numbering
		new Setting(containerEl).setName("Numbering").setHeading();
		new Setting(containerEl).setName("Page numbers").addDropdown((d) =>
			d.addOptions({ words: "PAGE ONE", digits: "PAGE 1" }).setValue(s.pageNumberStyle).onChange(async (v) => {
				s.pageNumberStyle = v as PageNumberStyle;
				await save();
			})
		);
		new Setting(containerEl)
			.setName("Balloon numbers")
			.setDesc("Numbering for lettering blocks (1., 2., 3.).")
			.addDropdown((d) =>
				d.addOptions({ page: "Restart each page", panel: "Restart each panel", off: "Off" }).setValue(s.balloonScope).onChange(async (v) => {
					s.balloonScope = v as BalloonScope;
					await save();
				})
			);

		// ---- Appearance
		new Setting(containerEl).setName("Editor appearance").setHeading();
		new Setting(containerEl)
			.setName("Draft font")
			.setDesc("CSS font stack for the editor. Uses Courier Final Draft or Courier Prime if installed.")
			.addText((t) => t.setValue(s.fontFamily).onChange(async (v) => {
				s.fontFamily = v || DEFAULT_SETTINGS.fontFamily;
				await save();
			}));
		new Setting(containerEl).setName("Font size").addSlider((sl) =>
			sl.setLimits(11, 24, 1).setValue(s.fontSize).setDynamicTooltip().onChange(async (v) => {
				s.fontSize = v;
				await save();
			})
		);
		new Setting(containerEl)
			.setName("Paper style")
			.setDesc("Auto uses dark paper when Obsidian's dark theme is on, and white paper otherwise. The toolbar's sun/moon button switches it too.")
			.addDropdown((d) =>
				d.addOptions({ auto: "Auto (match Obsidian)", light: "Light paper", dark: "Dark paper" }).setValue(s.paperMode).onChange(async (v) => {
					s.paperMode = v as PaperMode;
					await save();
				})
			);
		new Setting(containerEl)
			.setName("Animations")
			.setDesc("Smooth movement when you add, move, collapse or delete things. Always off if your system has reduced motion turned on.")
			.addToggle((t) => t.setValue(s.animations).onChange(async (v) => {
				s.animations = v;
				await save();
			}));
		new Setting(containerEl)
			.setName("Your name")
			.setDesc("Shown as the author of comments, in the Word export, and in new scripts' byline.")
			.addText((t) => t.setValue(s.authorName).onChange(async (v) => {
				s.authorName = v;
				await save();
			}));

		// ---- Export
		new Setting(containerEl).setName("Word export").setHeading();
		const toggle = (name: string, desc: string, key: "exportComments" | "exportRevisionMarks" | "exportHighlights" | "exportPageBreaks" | "openAfterExport") =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
				})
			);
		toggle("Comments", "Unresolved comments become Word margin comments.", "exportComments");
		toggle("Revision markers", "Prefix items marked for revision with a red [REVISE].", "exportRevisionMarks");
		toggle("Highlights", "Carry highlights (and ==marked text==) into Word.", "exportHighlights");
		toggle("Page break per page", "Start every comic page on a new Word page.", "exportPageBreaks");
		new Setting(containerEl)
			.setName("Word font")
			.setDesc("Font name written into the .docx. The Greg Pak template uses Courier Final Draft; Courier New is on every computer.")
			.addText((t) => t.setValue(s.exportFont).onChange(async (v) => {
				s.exportFont = v.trim() || DEFAULT_SETTINGS.exportFont;
				await save();
			}));
		toggle("Open after export", "Open the .docx in your default app (desktop only).", "openAfterExport");
		new Setting(containerEl)
			.setName("Export folder")
			.setDesc("Vault folder for .docx files; created automatically on the first export. Leave empty to save next to each script instead.")
			.addText((t) => t.setPlaceholder("Exported").setValue(s.exportFolder).onChange(async (v) => {
				s.exportFolder = v.trim().replace(/^\/+|\/+$/g, "");
				await save();
			}));
	}
}
