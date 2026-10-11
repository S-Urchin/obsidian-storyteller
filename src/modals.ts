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
			t.setPlaceholder("e.g. Radio chatter").setValue(d.name).onChange((v) => (d.name = v))
		);
		new Setting(contentEl).setName("Colour").addColorPicker((c) => c.setValue(d.color).onChange((v) => (d.color = v)));
		new Setting(contentEl)
			.setName("Layout")
			.setDesc("Description: prose, like a panel description. Lettering: 1. SPEAKER (modifier): text.")
			.addDropdown((dd) =>
				dd
					.addOptions({ description: "Description", lettering: "Lettering (speaker + text)" })
					.setValue(d.style)
					.onChange((v) => {
						d.style = v as BlockStyle;
						this.render();
					})
			);
		if (d.style === "lettering") {
			new Setting(contentEl)
				.setName("Numbered balloon")
				.setDesc("Counts toward the 1., 2., 3. lettering numbers.")
				.addToggle((t) => t.setValue(d.numbered).onChange((v) => (d.numbered = v)));
			new Setting(contentEl)
				.setName("Default speaker")
				.setDesc("Pre-filled speaker, e.g. CAPTION, SFX, RADIO.")
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
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(() => {
						this.onConfirm();
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
