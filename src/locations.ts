import { App, normalizePath, Platform, SuggestModal, TFolder } from "obsidian";

/*
 * Export and new-script folders. A folder is either a vault path ("Exported", "Comics/Drafts")
 * or, for exports on desktop, a full path on the computer ("C:\Users\me\Documents", "~/Desktop").
 */

interface NodeFs {
	promises: {
		mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
		writeFile(path: string, data: Uint8Array): Promise<void>;
	};
}
interface NodePath {
	join(...parts: string[]): string;
}
interface NodeOs {
	homedir(): string;
}
interface ElectronShell {
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
}
interface ElectronDialog {
	showOpenDialog(opts: { title?: string; properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}
interface ElectronModule {
	shell?: ElectronShell;
	remote?: { dialog?: ElectronDialog };
}

/** Node/Electron modules, loaded only when used so the plugin still starts on mobile. */
function nodeRequire<T>(id: string): T | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		return (req?.(id) as T | undefined) ?? null;
	} catch {
		return null;
	}
}

/** True for a full path on the computer rather than a folder inside the vault. */
export function isSystemPath(p: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || /^~([\\/]|$)/.test(p) || (!Platform.isWin && p.startsWith("/"));
}

/** Cleans up a folder typed into settings. Vault folders lose stray slashes; "" stays "". */
export function cleanFolder(raw: string): string {
	const p = raw.trim();
	if (!p) return "";
	if (isSystemPath(p)) return p;
	const vault = normalizePath(p).replace(/^\/+|\/+$/g, "");
	return vault === "/" ? "" : vault;
}

/** Folders that can be used on this device, without duplicates, last used first. */
export function usableFolders(list: string[], last: string | null, allowSystem: boolean): string[] {
	const out = [...new Set(list.map(cleanFolder))].filter((p) => !isSystemPath(p) || (allowSystem && Platform.isDesktopApp));
	const i = last === null ? -1 : out.indexOf(last);
	if (i > 0) out.unshift(...out.splice(i, 1));
	return out;
}

export function exportFolderLabel(p: string): string {
	if (!p) return "Next to the script";
	return isSystemPath(p) ? `${p} (on this computer)` : p;
}

/** Long paths keep their start (drive) and end (folder names): "C:\Users\…\Comics\Exports". */
export function shortPath(p: string, max = 44): string {
	if (p.length <= max) return p;
	const keep = max - 1;
	const head = Math.min(12, Math.floor(keep / 3));
	return p.slice(0, head) + "…" + p.slice(p.length - (keep - head));
}

export function scriptFolderLabel(p: string): string {
	return p || "Vault root";
}

/** Vault folder paths, for the settings autocomplete. */
export function vaultFolders(app: App): string[] {
	return app.vault
		.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
		.map((f) => f.path)
		.sort((a, b) => a.localeCompare(b));
}

/** Creates a vault folder (and its parents) if it doesn't exist yet. */
export async function ensureVaultFolder(app: App, folder: string): Promise<void> {
	if (!folder) return;
	const existing = app.vault.getAbstractFileByPath(folder);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`“${folder}” is a file, not a folder. Change the folder in settings.`);
	await app.vault.createFolder(folder);
}

/** Writes `data` to `<folder>/<name>` on the computer and returns the full path. */
export async function writeSystemFile(folder: string, name: string, data: ArrayBuffer): Promise<string> {
	const fs = nodeRequire<NodeFs>("fs");
	const path = nodeRequire<NodePath>("path");
	const os = nodeRequire<NodeOs>("os");
	if (!fs || !path || !os) throw new Error("Folders outside the vault only work in the desktop app.");
	const dir = /^~([\\/]|$)/.test(folder) ? path.join(os.homedir(), folder.slice(1)) : folder;
	await fs.promises.mkdir(dir, { recursive: true });
	const full = path.join(dir, name);
	await fs.promises.writeFile(full, new Uint8Array(data));
	return full;
}

export function systemShell(): ElectronShell | null {
	return nodeRequire<ElectronModule>("electron")?.shell ?? null;
}

function folderDialog(): ElectronDialog | null {
	const fromRequire = nodeRequire<ElectronModule>("electron")?.remote?.dialog;
	const fromWindow = (window as unknown as { electron?: ElectronModule }).electron?.remote?.dialog;
	return fromRequire ?? fromWindow ?? null;
}

/** Whether "Browse…" can open the system folder picker on this device. */
export function canBrowseFolders(): boolean {
	return folderDialog() !== null;
}

/** Opens the system folder picker; resolves to the chosen path, or null if cancelled. */
export async function browseForFolder(title: string): Promise<string | null> {
	const dialog = folderDialog();
	if (!dialog) return null;
	const r = await dialog.showOpenDialog({ title, properties: ["openDirectory", "createDirectory"] });
	return r.canceled ? null : r.filePaths[0] ?? null;
}

/** "Export to…" / "Create in…": choose one of the configured folders. */
export class FolderPickerModal extends SuggestModal<string> {
	constructor(
		app: App,
		private folders: string[],
		private label: (p: string) => string,
		private last: string | null,
		placeholder: string,
		private onPick: (folder: string) => void
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to choose" },
			{ command: "esc", purpose: "to cancel" },
		]);
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.folders.filter((f) => this.label(f).toLowerCase().includes(q));
	}

	renderSuggestion(folder: string, el: HTMLElement) {
		el.addClass("st-folder-suggestion");
		el.createDiv({ text: this.label(folder) });
		if (folder === this.last && this.folders.length > 1) el.createDiv({ cls: "st-folder-last", text: "Last used" });
	}

	onChooseSuggestion(folder: string) {
		this.onPick(folder);
	}
}
