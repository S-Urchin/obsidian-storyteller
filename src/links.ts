import { App, Keymap, TFile } from "obsidian";
import { LINK, linkShown } from "./format";

/*
 * [[Wiki links]] inside comments: rendering them as Obsidian links (click to open,
 * Ctrl+hover to preview) and suggesting vault notes while typing "[[".
 */

export const HOVER_SOURCE = "storyteller-comments";

/** Renders comment text with its [[links]] as working Obsidian internal links. */
export function renderLinked(parent: HTMLElement, text: string, app: App, sourcePath: string, hoverParent: unknown) {
	let last = 0;
	let m: RegExpExecArray | null;
	LINK.lastIndex = 0;
	while ((m = LINK.exec(text))) {
		if (m.index > last) parent.appendText(text.slice(last, m.index));
		const [, path, hash, alias] = m;
		const linktext = path + (hash ?? "");
		const a = parent.createEl("a", { cls: "internal-link st-note-link", text: linkShown(path, hash, alias), attr: { "data-href": linktext, href: linktext } });
		const dest = path ? app.metadataCache?.getFirstLinkpathDest?.(path, sourcePath) : null;
		if (!dest) a.addClass("is-unresolved");
		a.setAttr("aria-label", dest ? `Open ${dest.path}` : `Create “${path}”`);
		a.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation(); // don't also activate the comment card
			void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(e));
		});
		a.addEventListener("mouseover", (e) => {
			app.workspace.trigger("hover-link", { event: e, source: HOVER_SOURCE, hoverParent, targetEl: a, linktext, sourcePath });
		});
		last = m.index + m[0].length;
	}
	if (last < text.length) parent.appendText(text.slice(last));
}

interface Suggestion {
	file?: TFile;
	/** A link to a note that doesn't exist yet. */
	create?: string;
}

/**
 * Note suggestions for a textarea: typing "[[" opens a list of vault notes,
 * filtered as you type. ↑/↓ to move, Enter/Tab to insert, Esc to close.
 */
export class LinkSuggest {
	private el: HTMLElement | null = null;
	private items: Suggestion[] = [];
	private selected = 0;
	/** Index of the "[[" being completed. */
	private start = -1;

	constructor(private app: App, private ta: HTMLTextAreaElement, private host: HTMLElement, private sourcePath: () => string) {
		// Registered before the box's own keys, so Enter/Esc pick or close instead of submitting/cancelling.
		ta.addEventListener("keydown", (e) => this.onKey(e));
		ta.addEventListener("input", () => this.update());
		ta.addEventListener("click", () => this.update());
		ta.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
	}

	get isOpen() {
		return !!this.el;
	}

	/** For the 🔗 button: insert "[[" at the cursor and show the list. */
	begin() {
		const ta = this.ta;
		ta.focus();
		const pos = ta.selectionStart;
		ta.setRangeText("[[", pos, ta.selectionEnd, "end");
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	private update() {
		const ta = this.ta;
		const caret = ta.selectionStart;
		if (caret !== ta.selectionEnd) return this.close();
		const before = ta.value.slice(0, caret);
		const m = before.match(/\[\[([^[\]\n]*)$/);
		if (!m) return this.close();
		this.start = caret - m[0].length;
		const query = m[1].split("|")[0].split("#")[0].trim().toLowerCase();
		this.items = this.search(query, m[1].split("|")[0].trim());
		this.selected = 0;
		this.render();
	}

	private search(query: string, raw: string): Suggestion[] {
		const files = this.app.vault?.getFiles?.() ?? [];
		const scored: { file: TFile; score: number; exact: boolean }[] = [];
		for (const f of files) {
			if (f.path === this.sourcePath()) continue;
			const name = f.basename.toLowerCase();
			const path = f.path.toLowerCase();
			let score: number;
			if (!query) score = 3;
			else if (name === query) score = 0;
			else if (name.startsWith(query)) score = 1;
			else if (name.includes(query)) score = 2;
			else if (path.includes(query)) score = 3;
			else continue;
			const exact = score === 0;
			if (f.extension !== "md") score += 10; // every note before any attachment or other file
			scored.push({ file: f, score, exact });
		}
		scored.sort((a, b) => a.score - b.score || b.file.stat.mtime - a.file.stat.mtime);
		const out: Suggestion[] = scored.slice(0, 8).map((s) => ({ file: s.file }));
		if (raw && !scored.some((s) => s.exact)) out.push({ create: raw });
		return out;
	}

	private render() {
		if (!this.items.length) return this.close();
		if (!this.el) {
			this.el = this.host.createDiv({ cls: "st-link-suggest", attr: { role: "listbox", "aria-label": "Link to a note" } });
			// Clicking an item must not blur the textarea first.
			this.el.addEventListener("mousedown", (e) => e.preventDefault());
		}
		const el = this.el;
		el.empty();
		el.setCssStyles({ top: this.ta.offsetTop + this.ta.offsetHeight + 4 + "px" });
		this.items.forEach((item, i) => {
			const row = el.createDiv({ cls: "st-link-row", attr: { role: "option", "aria-selected": String(i === this.selected) } });
			row.toggleClass("is-selected", i === this.selected);
			if (item.file) {
				row.createDiv({ cls: "st-link-name", text: item.file.extension === "md" ? item.file.basename : item.file.name });
				const folder = item.file.parent && !item.file.parent.isRoot() ? item.file.parent.path : "";
				if (folder) row.createDiv({ cls: "st-link-path", text: folder });
			} else {
				row.createDiv({ cls: "st-link-name", text: `Link to new note “${item.create}”` });
			}
			row.addEventListener("mouseenter", () => {
				this.selected = i;
				el.querySelectorAll(".st-link-row").forEach((r, j) => r.toggleClass("is-selected", j === i));
			});
			row.addEventListener("click", () => this.choose(item));
		});
		el.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
	}

	private onKey(e: KeyboardEvent) {
		if (!this.el || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			this.selected = (this.selected + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
			this.render();
		} else if (e.key === "Enter" || e.key === "Tab") {
			this.choose(this.items[this.selected]);
		} else if (e.key === "Escape") {
			this.close();
		} else return;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	private choose(item: Suggestion | undefined) {
		if (!item) return;
		const ta = this.ta;
		const linktext = item.file ? this.app.metadataCache.fileToLinktext(item.file, this.sourcePath(), true) : item.create!;
		let end = ta.selectionStart;
		if (ta.value.slice(end, end + 2) === "]]") end += 2; // replace an auto-closed pair too
		const insert = `[[${linktext}]]`;
		ta.setRangeText(insert, this.start, end, "end");
		this.close();
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		ta.focus();
	}

	close() {
		this.el?.remove();
		this.el = null;
	}
}
