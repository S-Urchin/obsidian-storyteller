import { App, normalizePath, Notice, Plugin, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, EXPORT_FOLDER, FILE_EXTENSION, SETTINGS_SCHEMA, VIEW_TYPE_COMIC, VIEW_TYPE_PROJECTS } from "./defaults";
import { newDoc, normalizeDoc } from "./doc";
import { ensureSections, typeKey } from "./palette";
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
import { addIssue, nextIssueName, projectOf, removePath, renamePath, safeFileName } from "./projects";
import { ProjectsView, ProjectSuggestModal } from "./projects-view";
import { ComicDoc, ComicProject, StorytellerSettings } from "./types";
import { ComicView } from "./view";

export default class StorytellerPlugin extends Plugin {
	settings: StorytellerSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_COMIC, (leaf) => new ComicView(leaf, this));
		// Ctrl+hover a [[link]] in a comment for Obsidian's page preview (configurable under Page preview).
		this.registerHoverLinkSource(HOVER_SOURCE, { display: "Storyteller comic comments", defaultMod: true });
		this.registerView(VIEW_TYPE_PROJECTS, (leaf) => new ProjectsView(leaf, this));
		this.registerExtensions([FILE_EXTENSION], VIEW_TYPE_COMIC);
		this.addSettingTab(new StorytellerSettingTab(this.app, this));

		this.addRibbonIcon("book-open", "New comic script", () => this.createScript());
		this.addRibbonIcon("library", "Comic projects", () => void this.openProjects());

		this.addCommand({ id: "new-comic-script", name: "New comic script", callback: () => this.createScript() });
		this.addCommand({ id: "open-projects", name: "Open comic projects", callback: () => void this.openProjects() });
		this.addCommand({
			id: "new-issue",
			name: "New issue in the current project",
			checkCallback: (checking) => {
				const project = this.currentProject();
				if (!project) return false;
				if (!checking) void this.createIssue(project);
				return true;
			},
		});
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
					menu.addItem((i) => i.setTitle("Export as .docx").setIcon("file-output").onClick(() => void this.exportFile(file)));
					const s = this.settings;
					const owner = projectOf(s.projects, file.path);
					if (owner) {
						const n = owner.issues.indexOf(file.path) + 1;
						menu.addItem((i) => i.setTitle(`Issue #${n} of ${owner.name}`).setIcon("library").onClick(() => void this.openProjects(owner)));
					} else if (s.projects.length) {
						menu.addItem((i) =>
							i.setTitle("Add to project…").setIcon("library").onClick(() =>
								new ProjectSuggestModal(this.app, s.projects, (project) => {
									addIssue(s.projects, project, file.path);
									s.activeProject = project.id;
									void this.saveProjects();
									new Notice(`“${file.basename}” is now issue #${project.issues.length} of ${project.name}.`);
								}).open()
							)
						);
					}
				}
			})
		);

		// Keep project indexes pointing at their files when they're renamed, moved or deleted.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (renamePath(this.settings.projects, oldPath, file.path)) void this.saveProjects();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (removePath(this.settings.projects, file.path)) void this.saveProjects();
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
		this.settings.projects = (saved.projects ?? []).map((p) => ({ ...p, exportFolder: p.exportFolder ?? null, issues: [...(p.issues ?? [])] }));
		// Before stars, every block type showed under each panel; keep that until the user unstars some.
		this.settings.quickAdd = [...(saved.quickAdd ?? this.settings.blockTypes.map((t) => typeKey(t.id)))];

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

	/** Saves settings after a project change and redraws the Projects tab (scripts don't need it). */
	async saveProjects() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)) {
			if (leaf.view instanceof ProjectsView) leaf.view.render();
		}
	}

	/** The project the open script belongs to, or the one shown in the Projects tab. */
	currentProject(): ComicProject | null {
		const s = this.settings;
		const file = this.app.workspace.getActiveFile();
		return (file && projectOf(s.projects, file.path)) || s.projects.find((p) => p.id === s.activeProject) || s.projects[0] || null;
	}

	/** Shows the Projects tab in the left sidebar, on `project` if given. */
	async openProjects(project?: ComicProject) {
		if (project && this.settings.activeProject !== project.id) {
			this.settings.activeProject = project.id;
			await this.saveProjects();
		}
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_PROJECTS, active: true });
		}
		// Show the sidebar if it's collapsed, then bring the tab forward.
		if (leaf.getRoot() === workspace.leftSplit) workspace.leftSplit.expand();
		workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** Creates the next issue of a project in its scripts folder, indexes it last and opens it. */
	async createIssue(project: ComicProject) {
		try {
			const folder = project.folder;
			await ensureVaultFolder(this.app, folder);
			const base = folder ? folder + "/" : "";
			const pathOf = (name: string) => normalizePath(`${base}${name}.${FILE_EXTENSION}`);
			const { basename, number } = nextIssueName({ ...project, name: safeFileName(project.name) }, (name) => !!this.app.vault.getAbstractFileByPath(pathOf(name)));
			const doc = newDoc(this.settings, `${project.name} #${number}`);
			const file = await this.app.vault.create(pathOf(basename), JSON.stringify(doc, null, 2));
			addIssue(this.settings.projects, project, file.path);
			await this.saveProjects();
			await this.app.workspace.getLeaf(true).openFile(file);
		} catch (e) {
			console.error("Storyteller: couldn't create issue", e);
			new Notice(`Couldn't create the issue: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private openView(file: TFile): ComicView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMIC)) {
			if (leaf.view instanceof ComicView && leaf.view.file === file) return leaf.view;
		}
		return null;
	}

	/** Exports a script file that isn't necessarily open (file menu, Projects tab). */
	async exportFile(file: TFile) {
		const open = this.openView(file);
		if (open) return this.exportView(open);
		const doc = normalizeDoc(JSON.parse(await this.app.vault.read(file)), file.basename);
		await this.exportDoc(file, doc);
	}

	/** Exports every issue of a project, in order, to the project's Word folder. */
	async exportProject(project: ComicProject) {
		const files = project.issues.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile);
		if (!files.length) return;
		const folder = this.projectExportFolder(project) ?? this.exportFolders()[0] ?? "";
		let done = 0;
		for (const file of files) {
			const open = this.openView(file);
			if (open) await open.save();
			const doc = open ? open.doc : normalizeDoc(JSON.parse(await this.app.vault.read(file)), file.basename);
			// Opening a dozen Word windows at once helps nobody, so files aren't opened here.
			if (await this.exportTo(file, doc, folder, true)) done++;
		}
		if (done) new Notice(`Exported ${done} of ${files.length} ${files.length === 1 ? "issue" : "issues"} of ${project.name} to ${exportFolderLabel(folder)}.`, 8000);
	}

	/** A project's own Word folder, if it has one this device can use; null means the export folders from settings. */
	projectExportFolder(project: ComicProject | null): string | null {
		const f = project?.exportFolder ?? null;
		if (f === null || (isSystemPath(f) && !usableFolders([f], null, true).length)) return null;
		return f;
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
		this.rememberExportFolder(folder, view.file);
		await this.exportTo(view.file, view.doc, folder);
	}

	/**
	 * Export folders usable on this device, the default (last used) first unless `inOrder`.
	 * A script in a project with its own Word folder always defaults to that folder.
	 */
	exportFolders(inOrder = false, file?: TFile | null): string[] {
		const list = usableFolders(this.settings.exportFolders, inOrder ? null : this.settings.lastExportFolder, true);
		const own = file ? this.projectExportFolder(projectOf(this.settings.projects, file.path)) : null;
		return own === null ? list : [own, ...list.filter((f) => f !== own)];
	}

	private rememberExportFolder(folder: string, file?: TFile) {
		// A project's own folder isn't one of the settings' folders: don't make it the default for other scripts.
		if (file && folder === this.projectExportFolder(projectOf(this.settings.projects, file.path))) return;
		if (this.settings.lastExportFolder === folder) return;
		this.settings.lastExportFolder = folder;
		void this.saveData(this.settings);
	}

	/** Exports to the project's Word folder or the only export folder, or asks which one when settings list several. */
	async exportDoc(file: TFile, doc: ComicDoc) {
		const s = this.settings;
		const own = this.projectExportFolder(projectOf(s.projects, file.path));
		if (own !== null) return void (await this.exportTo(file, doc, own));
		const folders = this.exportFolders();
		if (folders.length <= 1) return this.exportTo(file, doc, folders[0] ?? "");
		new FolderPickerModal(this.app, folders, exportFolderLabel, s.lastExportFolder, `Export “${file.basename}.docx” to…`, (f) => {
			this.rememberExportFolder(f);
			void this.exportTo(file, doc, f);
		}).open();
	}

	/** `folder` is a vault folder, a full path on the computer, or "" for next to the script. */
	/**
	 * `quiet` (exporting a whole project) skips the per-file message and never opens the file.
	 * Resolves to whether the file was written.
	 */
	private async exportTo(file: TFile, doc: ComicDoc, folder: string, quiet = false): Promise<boolean> {
		const notice = new Notice(quiet ? `Exporting ${file.basename}.docx…` : "Exporting .docx…", 0);
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
			if (quiet) return true;

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
			return true;
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
					: `Export failed${quiet ? ` (${file.basename})` : ""}: ${e instanceof Error ? e.message : msg}`
			);
			return false;
		}
	}
}
