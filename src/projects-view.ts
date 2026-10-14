import { App, ItemView, Menu, Modal, Notice, setIcon, Setting, SuggestModal, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type StorytellerPlugin from "./main";
import { FILE_EXTENSION, VIEW_TYPE_COMIC, VIEW_TYPE_PROJECTS } from "./defaults";
import { normalizeDoc, uid } from "./doc";
import { browseForFolder, canBrowseFolders, cleanFolder, exportFolderLabel, isSystemPath, shortPath, vaultFolders } from "./locations";
import { ConfirmModal, PromptModal } from "./modals";
import { addStats, emptyStats, isInside, IssueStats, issueStats, moveIssue, naturalSort, projectOf } from "./projects";
import { ComicProject } from "./types";

type Tab = "issues" | "stats";

const fmt = (n: number) => n.toLocaleString();
const avg = (a: number, b: number) => (b ? (a / b).toFixed(1) : "–");

/**
 * The Projects tab in the sidebar: pick a project, see its issues in order, reorder them,
 * create the next one, export them all, and see stats for the whole series.
 */
export class ProjectsView extends ItemView {
	private activeTab: Tab = "issues";
	/** Parsed stats per file, kept until the file changes. */
	private statsCache = new Map<string, { mtime: number; stats: IssueStats | null }>();
	private renderTimer: number | null = null;
	private dragFrom = -1;

	constructor(leaf: WorkspaceLeaf, private plugin: StorytellerPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_PROJECTS;
	}

	getDisplayText() {
		return "Comic projects";
	}

	getIcon() {
		return "library";
	}

	async onOpen() {
		this.contentEl.addClass("st-projects");
		// Issue files change as they're written: keep page counts and stats current.
		const issue = (path: string) => !!this.project()?.issues.includes(path);
		// Scripts appearing, going or moving can change the "not in the index" list too.
		const script = (path: string) => issue(path) || path.endsWith("." + FILE_EXTENSION);
		this.registerEvent(this.app.vault.on("modify", (f) => issue(f.path) && this.scheduleRender()));
		this.registerEvent(this.app.vault.on("create", (f) => script(f.path) && this.scheduleRender()));
		this.registerEvent(this.app.vault.on("delete", (f) => script(f.path) && this.scheduleRender()));
		this.registerEvent(this.app.vault.on("rename", (f, old) => (script(f.path) || script(old)) && this.scheduleRender()));
		// Highlight the issue being edited.
		this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRender()));
		this.render();
	}

	async onClose() {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
	}

	/** Re-renders a moment later, so a burst of saves redraws once. */
	scheduleRender() {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.render();
		}, 400);
	}

	private project(): ComicProject | null {
		const s = this.plugin.settings;
		return s.projects.find((p) => p.id === s.activeProject) ?? s.projects[0] ?? null;
	}

	render() {
		const el = this.contentEl;
		const scroll = el.querySelector(".st-proj-body")?.scrollTop ?? 0;
		el.empty();
		const project = this.project();
		this.renderHeader(el, project);
		if (!project) return this.renderEmpty(el);

		const tabs = el.createDiv({ cls: "st-proj-tabs", attr: { role: "tablist" } });
		for (const [id, label, icon] of [
			["issues", "Issues", "list-ordered"],
			["stats", "Stats", "bar-chart-2"],
		] as [Tab, string, string][]) {
			const b = tabs.createEl("button", { cls: "st-proj-tab", attr: { role: "tab", "aria-selected": String(this.activeTab === id) } });
			setIcon(b.createSpan("st-proj-tab-icon"), icon);
			b.createSpan({ text: label });
			b.toggleClass("is-active", this.activeTab === id);
			b.addEventListener("click", () => {
				this.activeTab = id;
				this.render();
			});
		}
		const body = el.createDiv("st-proj-body");
		if (this.activeTab === "issues") void this.renderIssues(body, project).then(() => (body.scrollTop = scroll));
		else void this.renderStats(body, project).then(() => (body.scrollTop = scroll));
	}

	// ---------------------------------------------------------------- header

	private renderHeader(el: HTMLElement, project: ComicProject | null) {
		const s = this.plugin.settings;
		const bar = el.createDiv("st-proj-header");
		if (project) {
			const select = bar.createEl("select", { cls: "dropdown st-proj-select", attr: { "aria-label": "Project" } });
			for (const p of s.projects) select.createEl("option", { text: p.name, attr: { value: p.id } });
			select.value = project.id;
			select.addEventListener("change", () => {
				s.activeProject = select.value;
				void this.plugin.saveProjects();
			});
		} else {
			bar.createDiv({ cls: "st-proj-title", text: "Projects" });
		}
		this.iconButton(bar, "plus", "New project", () => this.newProject());
		if (project) {
			this.iconButton(bar, "settings", "Project settings", () =>
				new ProjectModal(this.app, this.plugin, project, (p) => {
					Object.assign(project, p);
					void this.plugin.saveProjects();
				}).open()
			);
		}
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void) {
		const b = parent.createEl("button", { cls: "clickable-icon st-proj-icon-btn", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	private renderEmpty(el: HTMLElement) {
		const box = el.createDiv("st-proj-empty");
		setIcon(box.createDiv("st-proj-empty-icon"), "library");
		box.createDiv({ cls: "st-proj-empty-title", text: "No projects yet" });
		box.createDiv({
			cls: "st-proj-empty-text",
			text: "A project keeps a series together: its issues in order, one folder for the scripts, one for the Word files, and stats for the whole run.",
		});
		box.createEl("button", { cls: "mod-cta", text: "New project" }).addEventListener("click", () => this.newProject());
	}

	private newProject() {
		new ProjectModal(this.app, this.plugin, null, (p, indexExisting) => {
			const s = this.plugin.settings;
			if (indexExisting) p.issues = naturalSort(this.unindexed(p).map((f) => f.path));
			s.projects.push(p);
			s.activeProject = p.id;
			this.activeTab = "issues";
			void this.plugin.saveProjects();
		}).open();
	}

	// ---------------------------------------------------------------- issues

	/** .comic files in the project's folder that no project has indexed yet. */
	private unindexed(project: ComicProject): TFile[] {
		const projects = this.plugin.settings.projects;
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension === FILE_EXTENSION && isInside(f.path, project.folder) && !projectOf(projects, f.path));
	}

	private fileAt(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	/** Stats for one issue file, from the cache unless the file changed; null if it can't be read. */
	private async stats(file: TFile): Promise<IssueStats | null> {
		const hit = this.statsCache.get(file.path);
		if (hit && hit.mtime === file.stat.mtime) return hit.stats;
		let stats: IssueStats | null = null;
		try {
			const doc = normalizeDoc(JSON.parse(await this.app.vault.cachedRead(file)), file.basename);
			stats = issueStats(doc, this.plugin.settings);
		} catch {
			stats = null;
		}
		this.statsCache.set(file.path, { mtime: file.stat.mtime, stats });
		return stats;
	}

	private async renderIssues(body: HTMLElement, project: ComicProject) {
		const where = body.createDiv("st-proj-where");
		this.whereRow(where, "folder", "Scripts", project.folder || "Vault root");
		const exportTo = project.exportFolder ?? null;
		this.whereRow(
			where,
			exportTo !== null && isSystemPath(exportTo) ? "hard-drive" : "file-output",
			"Word files",
			exportTo === null ? "Export folders from settings" : isSystemPath(exportTo) ? shortPath(exportTo, 34) : exportFolderLabel(exportTo),
			exportTo ?? undefined
		);

		const list = body.createDiv({ cls: "st-proj-issues", attr: { role: "list" } });
		if (!project.issues.length) {
			list.createDiv({ cls: "st-proj-hint", text: "No issues yet. Create the first one below, or add scripts already in the folder." });
		}
		const rows: HTMLElement[] = [];
		for (let i = 0; i < project.issues.length; i++) rows.push(await this.issueRow(list, project, i));

		const actions = body.createDiv("st-proj-actions");
		const add = actions.createEl("button", { cls: "mod-cta" });
		setIcon(add.createSpan("st-proj-btn-icon"), "plus");
		add.createSpan({ text: `New issue #${project.issues.length + 1}` });
		add.addEventListener("click", () => void this.plugin.createIssue(project));
		if (project.issues.length) {
			const all = actions.createEl("button");
			setIcon(all.createSpan("st-proj-btn-icon"), "file-output");
			all.createSpan({ text: "Export all" });
			all.addEventListener("click", () => void this.plugin.exportProject(project));
		}

		const loose = naturalSort(this.unindexed(project).map((f) => f.path));
		if (loose.length) {
			const section = body.createDiv("st-proj-loose");
			const head = section.createDiv("st-proj-section-head");
			head.createSpan({ text: `In the folder, not in the index (${loose.length})` });
			const addAll = head.createEl("button", { cls: "st-proj-link", text: "Add all" });
			addAll.addEventListener("click", () => {
				project.issues.push(...loose);
				void this.plugin.saveProjects();
			});
			for (const path of loose) {
				const row = section.createDiv("st-proj-loose-row");
				const name = row.createDiv({ cls: "st-proj-issue-name", text: this.fileAt(path)?.basename ?? path });
				name.title = path;
				name.addEventListener("click", (e) => void this.openIssue(path, e));
				const b = row.createEl("button", { cls: "st-proj-link", text: `Add as #${project.issues.length + 1}` });
				b.addEventListener("click", () => {
					project.issues.push(path);
					void this.plugin.saveProjects();
				});
			}
		}
	}

	private whereRow(parent: HTMLElement, icon: string, label: string, value: string, title?: string) {
		const row = parent.createDiv("st-proj-where-row");
		setIcon(row.createSpan("st-proj-where-icon"), icon);
		row.createSpan({ cls: "st-proj-where-label", text: label });
		row.createSpan({ cls: "st-proj-where-value", text: value, attr: { title: title ?? value } });
	}

	private async issueRow(list: HTMLElement, project: ComicProject, i: number): Promise<HTMLElement> {
		const path = project.issues[i];
		const file = this.fileAt(path);
		const row = list.createDiv({ cls: "st-proj-issue", attr: { role: "listitem", draggable: "true" } });
		row.toggleClass("is-missing", !file);
		row.toggleClass("is-current", !!file && this.app.workspace.getActiveFile()?.path === path);
		row.createDiv({ cls: "st-proj-issue-num", text: "#" + (i + 1) });
		const text = row.createDiv("st-proj-issue-text");
		text.createDiv({ cls: "st-proj-issue-name", text: file?.basename ?? path.split("/").pop() ?? path });
		const meta = text.createDiv("st-proj-issue-meta");
		if (!file) {
			meta.setText("File not found: moved outside Obsidian or deleted");
		} else {
			const st = await this.stats(file);
			meta.setText(
				st
					? `${st.pages} ${st.pages === 1 ? "page" : "pages"} · ${fmt(st.descriptionWords + st.letteringWords)} words` +
							(st.openComments ? ` · ${st.openComments} open ${st.openComments === 1 ? "comment" : "comments"}` : "")
					: "Can't read this script"
			);
		}
		row.title = path;
		row.addEventListener("click", (e) => {
			if (file) void this.openIssue(path, e);
		});
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.issueMenu(project, i, file).showAtMouseEvent(e);
		});
		const more = this.iconButton(row, "more-vertical", "Issue options", (e) => {
			e.stopPropagation();
			this.issueMenu(project, i, file).showAtMouseEvent(e);
		});
		more.addClass("st-proj-issue-more");

		// Drag to reorder: the line shows where the issue will land.
		row.addEventListener("dragstart", (e) => {
			this.dragFrom = i;
			row.addClass("is-dragging");
			e.dataTransfer?.setData("text/plain", path);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		row.addEventListener("dragend", () => {
			this.dragFrom = -1;
			row.removeClass("is-dragging");
			list.querySelectorAll(".st-drop-before, .st-drop-after").forEach((r) => r.removeClasses(["st-drop-before", "st-drop-after"]));
		});
		const after = (e: DragEvent) => {
			const r = row.getBoundingClientRect();
			return e.clientY > r.top + r.height / 2;
		};
		row.addEventListener("dragover", (e) => {
			if (this.dragFrom < 0) return;
			e.preventDefault();
			const below = after(e);
			row.toggleClass("st-drop-after", below);
			row.toggleClass("st-drop-before", !below);
		});
		row.addEventListener("dragleave", () => row.removeClasses(["st-drop-before", "st-drop-after"]));
		row.addEventListener("drop", (e) => {
			if (this.dragFrom < 0) return;
			e.preventDefault();
			let to = i + (after(e) ? 1 : 0);
			if (this.dragFrom < to) to--;
			moveIssue(project, this.dragFrom, to);
			this.dragFrom = -1;
			void this.plugin.saveProjects();
		});
		return row;
	}

	private issueMenu(project: ComicProject, i: number, file: TFile | null): Menu {
		const menu = new Menu();
		const save = () => void this.plugin.saveProjects();
		const n = project.issues.length;
		if (file) {
			menu.addItem((it) => it.setTitle("Open").setIcon("book-open").onClick(() => void this.openIssue(file.path)));
			menu.addItem((it) => it.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.app.workspace.getLeaf("tab").openFile(file)));
			menu.addItem((it) => it.setTitle("Export .docx").setIcon("file-output").onClick(() => void this.plugin.exportFile(file)));
			menu.addItem((it) =>
				it.setTitle("Rename…").setIcon("pencil").onClick(() =>
					new PromptModal(this.app, "Rename issue", file.basename, (name) => {
						const path = (file.parent && !file.parent.isRoot() ? file.parent.path + "/" : "") + `${name}.${FILE_EXTENSION}`;
						if (this.app.vault.getAbstractFileByPath(path)) return void new Notice(`“${name}” already exists in that folder.`);
						// The rename event updates the index.
						void this.app.fileManager.renameFile(file, path);
					}).open()
				)
			);
			menu.addSeparator();
		}
		menu.addItem((it) => it.setTitle("Move up").setIcon("arrow-up").setDisabled(i === 0).onClick(() => (moveIssue(project, i, i - 1), save())));
		menu.addItem((it) => it.setTitle("Move down").setIcon("arrow-down").setDisabled(i === n - 1).onClick(() => (moveIssue(project, i, i + 1), save())));
		menu.addItem((it) =>
			it.setTitle("Change issue number…").setIcon("list-ordered").setDisabled(n < 2).onClick(() =>
				new PromptModal(this.app, `Issue number (1–${n})`, String(i + 1), (v) => {
					const to = parseInt(v, 10);
					if (!(to >= 1 && to <= n)) return void new Notice(`Type a number from 1 to ${n}.`);
					moveIssue(project, i, to - 1);
					save();
				}).open()
			)
		);
		menu.addSeparator();
		menu.addItem((it) =>
			it.setTitle("Remove from project").setIcon("x").onClick(() => {
				project.issues.splice(i, 1);
				save();
				new Notice(file ? `Removed “${file.basename}” from ${project.name}. The file is still in your vault.` : "Removed from the project.");
			})
		);
		return menu;
	}

	private async openIssue(path: string, e?: MouseEvent) {
		const file = this.fileAt(path);
		if (!file) return;
		const newTab = !!e && (e.ctrlKey || e.metaKey || e.button === 1);
		// Reuse a tab that already shows it.
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMIC).find((l) => (l.view as { file?: TFile }).file?.path === path);
		if (existing && !newTab) return this.app.workspace.setActiveLeaf(existing, { focus: true });
		await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	// ---------------------------------------------------------------- stats

	private async renderStats(body: HTMLElement, project: ComicProject) {
		const rows: { i: number; name: string; path: string; st: IssueStats }[] = [];
		for (let i = 0; i < project.issues.length; i++) {
			const file = this.fileAt(project.issues[i]);
			const st = file ? await this.stats(file) : null;
			if (file && st) rows.push({ i, name: file.basename, path: file.path, st });
		}
		if (!rows.length) {
			body.createDiv({ cls: "st-proj-hint", text: "Stats appear once the project has an issue." });
			return;
		}
		const total = rows.reduce((t, r) => addStats(t, r.st), emptyStats());
		const words = total.descriptionWords + total.letteringWords;

		const tiles = body.createDiv("st-stat-tiles");
		const tile = (value: string, label: string) => {
			const t = tiles.createDiv("st-stat-tile");
			t.createDiv({ cls: "st-stat-value", text: value });
			t.createDiv({ cls: "st-stat-label", text: label });
		};
		tile(fmt(rows.length), rows.length === 1 ? "Issue" : "Issues");
		tile(fmt(total.pages), "Pages");
		tile(fmt(total.panels), "Panels");
		tile(fmt(words), "Words");

		this.section(body, "Averages");
		const dl = body.createDiv("st-stat-list");
		const line = (label: string, value: string, hint?: string) => {
			const r = dl.createDiv("st-stat-line");
			r.createSpan({ cls: "st-stat-line-label", text: label });
			const v = r.createSpan({ cls: "st-stat-line-value", text: value });
			if (hint) v.title = hint;
		};
		line("Pages per issue", avg(total.pages, rows.length));
		line("Panels per page", avg(total.panels, total.pages));
		line("Words per page", avg(words, total.pages));
		line("Balloons per panel", avg(total.balloons, total.panels), "Numbered lettering: dialogue, captions, thoughts, SFX");
		line("Lettering words per panel", avg(total.letteringWords, total.panels));
		line("Most lettering in one panel", `${fmt(total.busiestPanelWords)} words`, "Panels with lots of lettering get crowded");
		line("Description / lettering", `${fmt(total.descriptionWords)} / ${fmt(total.letteringWords)} words`);
		line("Open comments", fmt(total.openComments));
		line("Marked for revision", fmt(total.revisions));

		this.section(body, "Pages per issue");
		this.bars(
			body,
			rows.map((r) => ({ label: `#${r.i + 1}`, title: r.name, value: r.st.pages, unit: "pages", path: r.path }))
		);

		this.section(body, "Words per issue");
		this.bars(
			body,
			rows.map((r) => ({ label: `#${r.i + 1}`, title: r.name, value: r.st.descriptionWords + r.st.letteringWords, unit: "words", path: r.path }))
		);

		if (total.speakers.size) {
			this.section(body, "Cast by balloons");
			const cast = [...total.speakers.entries()].sort((a, b) => b[1] - a[1]);
			const shown = cast.slice(0, 12);
			const rest = cast.slice(12).reduce((n, [, c]) => n + c, 0);
			const items = shown.map(([who, n]) => {
				const issues = rows.filter((r) => r.st.speakers.has(who)).map((r) => "#" + (r.i + 1));
				return { label: who, title: `${who}: in ${issues.length === rows.length ? "every issue" : "issues " + issues.join(", ")}`, value: n, unit: "balloons" };
			});
			if (rest) items.push({ label: `Others (${cast.length - 12})`, title: cast.slice(12).map(([w]) => w).join(", "), value: rest, unit: "balloons" });
			this.bars(body, items, true);
		}

		this.section(body, "By issue");
		const wrap = body.createDiv("st-stat-table-wrap");
		const table = wrap.createEl("table", { cls: "st-stat-table" });
		const head = table.createEl("thead").createEl("tr");
		for (const h of ["#", "Issue", "Pages", "Panels", "Words"]) head.createEl("th", { text: h });
		const tbody = table.createEl("tbody");
		for (const r of rows) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: String(r.i + 1) });
			const name = tr.createEl("td", { cls: "st-stat-table-name", text: r.name });
			name.addEventListener("click", (e) => void this.openIssue(r.path, e));
			for (const v of [r.st.pages, r.st.panels, r.st.descriptionWords + r.st.letteringWords]) tr.createEl("td", { text: fmt(v) });
		}
		const foot = table.createEl("tfoot").createEl("tr");
		foot.createEl("td");
		foot.createEl("td", { text: "Total" });
		for (const v of [total.pages, total.panels, words]) foot.createEl("td", { text: fmt(v) });

		const missing = project.issues.length - rows.length;
		if (missing) body.createDiv({ cls: "st-proj-hint", text: `${missing} ${missing === 1 ? "issue is" : "issues are"} missing or unreadable and not counted.` });
	}

	private section(body: HTMLElement, title: string) {
		body.createDiv({ cls: "st-proj-section-head", text: title });
	}

	/** Horizontal bars, one series, value printed at the end of each bar. */
	private bars(body: HTMLElement, items: { label: string; title: string; value: number; unit: string; path?: string }[], wideLabels = false) {
		const max = Math.max(1, ...items.map((it) => it.value));
		const chart = body.createDiv("st-bars");
		chart.toggleClass("st-bars-wide", wideLabels);
		for (const it of items) {
			const row = chart.createDiv({ cls: "st-bar-row", attr: { title: `${it.title}: ${fmt(it.value)} ${it.unit}` } });
			row.createSpan({ cls: "st-bar-label", text: it.label });
			const track = row.createDiv("st-bar-track");
			const bar = track.createDiv("st-bar");
			bar.setCssStyles({ width: `${(it.value / max) * 100}%` });
			row.createSpan({ cls: "st-bar-value", text: fmt(it.value) });
			if (it.path) {
				row.addClass("is-clickable");
				const path = it.path;
				row.addEventListener("click", (e) => void this.openIssue(path, e));
			}
		}
	}
}

/** Creates or edits a project: its name, the scripts folder and the Word files folder. */
export class ProjectModal extends Modal {
	private draft: ComicProject;
	private isNew: boolean;
	private indexExisting = true;

	constructor(app: App, private plugin: StorytellerPlugin, existing: ComicProject | null, private onSave: (project: ComicProject, indexExisting: boolean) => void) {
		super(app);
		this.draft = existing ? { ...existing, issues: [...existing.issues] } : { id: uid(), name: "", folder: "", exportFolder: null, issues: [] };
		this.isNew = !existing;
	}

	onOpen() {
		this.titleEl.setText(this.isNew ? "New project" : `Project: ${this.draft.name}`);
		this.modalEl.addClass("st-project-modal");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const d = this.draft;
		const datalist = contentEl.createEl("datalist", { attr: { id: "st-project-folders" } });
		for (const path of vaultFolders(this.app)) datalist.createEl("option", { attr: { value: path } });

		let folderInput: { setValue(v: string): unknown } | null = null;
		new Setting(contentEl).setName("Name").setDesc("New issue files are named after it, with the issue number at the end.").addText((t) => {
			t.setPlaceholder("Series title").setValue(d.name).onChange((v) => {
				const followed = !d.folder || d.folder === "Comics/" + d.name.trim();
				d.name = v;
				// Suggest a folder named after the project until one is typed.
				if (this.isNew && followed) {
					d.folder = v.trim() ? "Comics/" + v.trim() : "";
					folderInput?.setValue(d.folder);
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(contentEl)
			.setName("Scripts folder")
			.setDesc("Vault folder where this project's .comic issues are created. It's made if it doesn't exist.")
			.addText((t) => {
				folderInput = t;
				t.setPlaceholder("Vault root").setValue(d.folder);
				t.inputEl.setAttr("list", "st-project-folders");
				t.onChange((v) => (d.folder = cleanFolder(v)));
			});

		const exportSetting = new Setting(contentEl)
			.setName("Word files folder")
			.setDesc("Where Export .docx saves this project's issues: a vault folder or, in the desktop app, a folder on your computer. Leave empty to use the export folders from settings.");
		exportSetting.addText((t) => {
			t.setPlaceholder("Export folders from settings").setValue(d.exportFolder ?? "");
			t.inputEl.setAttr("list", "st-project-folders");
			t.inputEl.addClass("st-folder-input");
			t.onChange((v) => {
				const c = cleanFolder(v);
				d.exportFolder = c ? c : null;
			});
		});
		if (canBrowseFolders()) {
			exportSetting.addButton((b) =>
				b.setButtonText("Browse…").onClick(async () => {
					const picked = await browseForFolder("Choose where this project's Word files go");
					if (!picked) return;
					d.exportFolder = picked;
					this.render();
				})
			);
		}

		if (this.isNew) {
			new Setting(contentEl)
				.setName("Add scripts already in the folder")
				.setDesc("Index the .comic files already in the scripts folder as issues, ordered by name. You can reorder them afterwards.")
				.addToggle((t) => t.setValue(this.indexExisting).onChange((v) => (this.indexExisting = v)));
		}

		const buttons = new Setting(contentEl);
		if (!this.isNew) {
			buttons.addButton((b) => {
				b.buttonEl.addClass("mod-warning");
				b.setButtonText("Delete project").onClick(() =>
					new ConfirmModal(
						this.app,
						"Delete project?",
						`“${d.name}” and its issue order are removed from Storyteller. The scripts and Word files stay in your vault.`,
						"Delete project",
						() => {
							const s = this.plugin.settings;
							s.projects = s.projects.filter((p) => p.id !== d.id);
							if (s.activeProject === d.id) s.activeProject = s.projects[0]?.id ?? null;
							void this.plugin.saveProjects();
							this.close();
						}
					).open()
				);
			});
		}
		buttons.addButton((b) =>
			b
				.setButtonText(this.isNew ? "Create project" : "Save")
				.setCta()
				.onClick(() => {
					d.name = d.name.trim() || "Untitled project";
					const existing = this.app.vault.getAbstractFileByPath(d.folder);
					if (d.folder && existing && !(existing instanceof TFolder)) return void new Notice(`“${d.folder}” is a file, not a folder.`);
					this.onSave(d, this.isNew && this.indexExisting);
					this.close();
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** "Add to project…": choose which project a script joins. */
export class ProjectSuggestModal extends SuggestModal<ComicProject> {
	constructor(app: App, private projects: ComicProject[], private onPick: (project: ComicProject) => void) {
		super(app);
		this.setPlaceholder("Add to project…");
	}

	getSuggestions(query: string): ComicProject[] {
		const q = query.toLowerCase();
		return this.projects.filter((p) => p.name.toLowerCase().includes(q));
	}

	renderSuggestion(project: ComicProject, el: HTMLElement) {
		el.createDiv({ text: project.name });
		el.createDiv({ cls: "st-folder-last", text: `${project.issues.length} ${project.issues.length === 1 ? "issue" : "issues"} · becomes #${project.issues.length + 1}` });
	}

	onChooseSuggestion(project: ComicProject) {
		this.onPick(project);
	}
}
