import { App, normalizePath, Notice, Plugin, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, EXPORT_FOLDER, FILE_EXTENSION, SETTINGS_SCHEMA, VIEW_TYPE_COMIC } from "./defaults";
import { newDoc, normalizeDoc } from "./doc";
import { ensureSections } from "./palette";
import { HOVER_SOURCE } from "./links";
import { exportDocx } from "./export-docx";
import {
	ensureVaultFolder,
	exportFolderLabel,
	FolderPickerModal,
	isSystemPath,
	scriptFolderLabel,
	systemShell,
	usableFolders,
	writeSystemFile,
} from "./locations";
import { StorytellerSettingTab } from "./settings";
import { ComicDoc, StorytellerSettings } from "./types";
import { ComicView } from "./view";

export default class StorytellerPlugin extends Plugin {
	settings: StorytellerSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_COMIC, (leaf) => new ComicView(leaf, this));
		// Ctrl+hover a [[link]] in a comment for Obsidian's page preview (configurable under Page preview).
		this.registerHoverLinkSource(HOVER_SOURCE, { display: "Storyteller comic comments", defaultMod: true });
		this.registerExtensions([FILE_EXTENSION], VIEW_TYPE_COMIC);
		this.addSettingTab(new StorytellerSettingTab(this.app, this));

		this.addRibbonIcon("book-open", "New comic script", () => this.createScript());

		this.addCommand({ id: "new-comic-script", name: "New comic script", callback: () => this.createScript() });
		this.addCommand({
			id: "export-docx",
			name: "Export current script as .docx",
			checkCallback: (checking) => this.withView(checking, (v) => void this.exportView(v)),
		});
		this.addCommand({
			id: "add-page",
			name: "Add page",
			checkCallback: (checking) => this.withView(checking, (v) => v.addPage()),
		});
		this.addCommand({
			id: "toggle-read-mode",
			name: "Toggle read mode",
			checkCallback: (checking) => this.withView(checking, (v) => v.toggleReadMode()),
		});
		this.addCommand({
			id: "swap-page",
			name: "Swap current page with\u2026",
			checkCallback: (checking) => this.withView(checking, (v) => v.pickCurrentPage("swap")),
		});
		this.addCommand({
			id: "move-page",
			name: "Move current page to position\u2026",
			checkCallback: (checking) => this.withView(checking, (v) => v.pickCurrentPage("move")),
		});
		this.addCommand({
			id: "show-shortcuts",
			name: "Show help and keyboard shortcuts",
			checkCallback: (checking) => this.withView(checking, (v) => v.showHelp()),
		});
		this.addCommand({
			id: "collapse-all",
			name: "Collapse all pages",
			checkCallback: (checking) => this.withView(checking, (v) => v.setAllCollapsed(true)),
		});
		this.addCommand({
			id: "expand-all",
			name: "Expand all pages and panels",
			checkCallback: (checking) => this.withView(checking, (v) => v.setAllCollapsed(false)),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((i) => i.setTitle("New comic script").setIcon("book-open").onClick(() => this.createScript(file)));
				} else if (file instanceof TFile && file.extension === FILE_EXTENSION) {
					menu.addItem((i) =>
						i.setTitle("Export as .docx").setIcon("file-output").onClick(async () => {
							const doc = normalizeDoc(JSON.parse(await this.app.vault.read(file)), file.basename);
							await this.exportDoc(file, doc);
						})
					);
				}
			})
		);
	}

	private withView(checking: boolean, fn: (v: ComicView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(ComicView);
		if (!view) return false;
		if (!checking) fn(view);
		return true;
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<StorytellerSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Never share the default arrays with the live settings object.
		this.settings.blockTypes = (saved.blockTypes ?? DEFAULT_SETTINGS.blockTypes).map((t) => ({ ...t }));
		this.settings.presets = [...(saved.presets ?? [])];
		this.settings.newPanelBlocks = [...(saved.newPanelBlocks ?? DEFAULT_SETTINGS.newPanelBlocks)];
		this.settings.paletteSections = (saved.paletteSections ?? []).map((s) => ({ ...s, items: [...(s.items ?? [])] }));
		this.settings.scriptFolders = [...(saved.scriptFolders ?? [])];

		// v1 had a "Note to artist" block and a "note" layout; notes are now comments.
		if ((saved.schema ?? 1) < 2) {
			this.settings.blockTypes = this.settings.blockTypes.filter((t) => t.id !== "note");
			this.settings.newPanelBlocks = this.settings.newPanelBlocks.filter((id) => id !== "note");
		}
		// v2 saved .docx files next to the script; they now go to an "Exported" folder.
		// Up to v6 there was a single export folder; now there's a list to choose from.
		const legacy = saved as { exportFolder?: string };
		const single = (saved.schema ?? 1) < 3 && !legacy.exportFolder ? EXPORT_FOLDER : legacy.exportFolder ?? EXPORT_FOLDER;
		this.settings.exportFolders = [...(saved.exportFolders ?? [single])];
		delete (this.settings as { exportFolder?: string }).exportFolder;
		// v3 had "paper" (always white) and "theme"; dark paper arrived in v4, following Obsidian by default.
		if (!["auto", "light", "dark"].includes(this.settings.paperMode)) this.settings.paperMode = "auto";
		// v5 adds the Freestyle block for existing installs too.
		if ((saved.schema ?? 1) < 5 && !this.settings.blockTypes.some((t) => t.id === "freestyle")) {
			const free = DEFAULT_SETTINGS.blockTypes.find((t) => t.id === "freestyle");
			if (free) this.settings.blockTypes.push({ ...free });
		}
		// v6: exported files open automatically by default (was opt-in).
		if ((saved.schema ?? 1) < 6) this.settings.openAfterExport = true;
		for (const t of this.settings.blockTypes) if (!["description", "lettering", "freestyle"].includes(t.style)) t.style = "description";
		this.settings.schema = SETTINGS_SCHEMA;
		ensureSections(this.settings);
	}

	/**
	 * Saves settings and refreshes open scripts. `from` is the view the change came from:
	 * it only redraws what `scope` says changed, so inline palette edits keep their focus.
	 * Other open scripts are always fully redrawn.
	 */
	async saveSettings(opts: { from?: ComicView; scope?: "all" | "script" | "palette" | "none" } = {}) {
		ensureSections(this.settings);
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMIC)) {
			const view = leaf.view;
			if (!(view instanceof ComicView)) continue;
			if (view !== opts.from) view.renderAll();
			else if (opts.scope === "script") view.refreshScript();
			else if (opts.scope === "palette") view.renderPalette();
			else if (opts.scope !== "none") view.renderAll();
		}
	}

	/** Right-clicked folder wins; otherwise one of the script folders from settings (asks when there are several). */
	async createScript(folder?: TFolder) {
		if (folder) return this.createScriptIn(folder.isRoot() ? "" : folder.path);
		const s = this.settings;
		const folders = usableFolders(s.scriptFolders, s.lastScriptFolder, false);
		if (!folders.length) {
			const parent = this.app.workspace.getActiveFile()?.parent ?? this.app.fileManager.getNewFileParent("");
			return this.createScriptIn(parent.isRoot() ? "" : parent.path);
		}
		if (folders.length === 1) return this.createScriptIn(folders[0]);
		new FolderPickerModal(this.app, folders, scriptFolderLabel, s.lastScriptFolder, "Create the new script in…", (f) => {
			s.lastScriptFolder = f;
			void this.saveData(s);
			void this.createScriptIn(f);
		}).open();
	}

	private async createScriptIn(folder: string) {
		try {
			await ensureVaultFolder(this.app, folder);
			const base = folder ? folder + "/" : "";
			let name = "Untitled script";
			for (let i = 2; this.app.vault.getAbstractFileByPath(normalizePath(`${base}${name}.${FILE_EXTENSION}`)); i++) {
				name = `Untitled script ${i}`;
			}
			const doc = newDoc(this.settings, name);
			const file = await this.app.vault.create(normalizePath(`${base}${name}.${FILE_EXTENSION}`), JSON.stringify(doc, null, 2));
			await this.app.workspace.getLeaf(true).openFile(file);
		} catch (e) {
			console.error("Storyteller: couldn't create script", e);
			new Notice(`Couldn't create the script: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** With no `folder`, asks which export folder to use when there are several. */
	async exportView(view: ComicView, folder?: string) {
		if (!view.file) return;
		await view.save();
		if (folder === undefined) return this.exportDoc(view.file, view.doc);
		this.rememberExportFolder(folder);
		await this.exportTo(view.file, view.doc, folder);
	}

	/** Export folders usable on this device, the default (last used) first unless `inOrder`. */
	exportFolders(inOrder = false): string[] {
		return usableFolders(this.settings.exportFolders, inOrder ? null : this.settings.lastExportFolder, true);
	}

	private rememberExportFolder(folder: string) {
		if (this.settings.lastExportFolder === folder) return;
		this.settings.lastExportFolder = folder;
		void this.saveData(this.settings);
	}

	/** Exports to the only export folder, or asks which one when settings list several. */
	async exportDoc(file: TFile, doc: ComicDoc) {
		const s = this.settings;
		const folders = this.exportFolders();
		if (folders.length <= 1) return this.exportTo(file, doc, folders[0] ?? "");
		new FolderPickerModal(this.app, folders, exportFolderLabel, s.lastExportFolder, `Export “${file.basename}.docx” to…`, (f) => {
			this.rememberExportFolder(f);
			void this.exportTo(file, doc, f);
		}).open();
	}

	/** `folder` is a vault folder, a full path on the computer, or "" for next to the script. */
	private async exportTo(file: TFile, doc: ComicDoc, folder: string) {
		const notice = new Notice("Exporting .docx…", 0);
		try {
			const buffer = await exportDocx(doc, this.settings);
			const name = `${file.basename}.docx`;
			const autoOpen = this.settings.openAfterExport;
			let path: string;
			let open: (() => void) | null = null;
			let reveal: (() => void) | null = null;

			if (isSystemPath(folder)) {
				path = await writeSystemFile(folder, name, buffer);
				const shell = systemShell();
				if (shell) {
					open = () => void shell.openPath(path);
					reveal = () => shell.showItemInFolder(path);
				}
			} else {
				const target = folder || (file.parent && !file.parent.isRoot() ? file.parent.path : "");
				await ensureVaultFolder(this.app, target);
				path = normalizePath(`${target ? target + "/" : ""}${name}`);
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buffer);
				else await this.app.vault.createBinary(path, buffer);
				// Obsidian's own "Open in default app" / "Show in system explorer" helpers. They aren't in the
				// public typings and may be missing (e.g. on some mobile setups), so they're used only when present.
				const app = this.app as App & { showInFolder?: (path: string) => void; openWithDefaultApp?: (path: string) => void };
				if (app.openWithDefaultApp) open = () => app.openWithDefaultApp?.(path);
				if (app.showInFolder) reveal = () => app.showInFolder?.(path);
			}
			notice.hide();

			new Notice(
				createFragment((f) => {
					f.appendText(`Exported to ${path}. `);
					if (autoOpen && open) f.appendText("Opening it in your default app (you can turn this off in settings). ");
					else if (autoOpen) f.appendText("Open it from that folder: this device can't open it automatically. ");
					if (!reveal) return;
					f.createEl("a", { cls: "st-notice-link", text: "Show in file manager", attr: { href: "#" } }).addEventListener("click", (e) => {
						e.preventDefault();
						reveal?.();
					});
				}),
				8000
			);
			if (autoOpen) open?.();
		} catch (e) {
			notice.hide();
			console.error("Storyteller export failed", e);
			const msg = String(e);
			const busy = msg.includes("EBUSY");
			const denied = msg.includes("EPERM") || msg.includes("EACCES");
			new Notice(
				busy
					? "Export failed: close the .docx in Word and try again."
					: denied
					? `Export failed: no permission to write to ${exportFolderLabel(folder)}. Pick another folder in settings.`
					: `Export failed: ${e instanceof Error ? e.message : msg}`
			);
		}
	}
}
