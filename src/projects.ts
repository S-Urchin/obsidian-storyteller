import { findType, wordCount } from "./doc";
import { plainText } from "./format";
import { ComicDoc, ComicProject, StorytellerSettings } from "./types";

/*
 * Projects: an ordered index of issues per series. Pure functions over the settings data,
 * so they can be tested without Obsidian; the Projects tab and the vault events call them.
 */

/** The project an issue file is indexed in, if any. */
export function projectOf(projects: ComicProject[], path: string): ComicProject | null {
	return projects.find((p) => p.issues.includes(path)) ?? null;
}

/** True when `path` is `folder` itself or anything inside it ("" is the vault root). */
export function isInside(path: string, folder: string): boolean {
	return !folder || path === folder || path.startsWith(folder + "/");
}

/**
 * Adds an issue at the end of a project (or at `at`). An issue belongs to one project only:
 * returns the project that already has it instead of adding it twice.
 */
export function addIssue(projects: ComicProject[], project: ComicProject, path: string, at = project.issues.length): ComicProject | null {
	const owner = projectOf(projects, path);
	if (owner) return owner;
	project.issues.splice(Math.max(0, Math.min(at, project.issues.length)), 0, path);
	return null;
}

/** Moves issue `from` to position `to` (0-based), shifting the issues in between. */
export function moveIssue(project: ComicProject, from: number, to: number): void {
	const n = project.issues.length;
	if (from < 0 || from >= n) return;
	const target = Math.max(0, Math.min(to, n - 1));
	if (target === from) return;
	project.issues.splice(target, 0, project.issues.splice(from, 1)[0]);
}

/** Follows a renamed or moved file or folder. Returns true if anything changed. */
export function renamePath(projects: ComicProject[], oldPath: string, newPath: string): boolean {
	const swap = (p: string) => (p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p);
	let changed = false;
	for (const project of projects) {
		const issues = project.issues.map(swap);
		if (issues.some((p, i) => p !== project.issues[i])) {
			project.issues = issues;
			changed = true;
		}
		if (project.folder) {
			const folder = swap(project.folder);
			if (folder !== project.folder) {
				project.folder = folder;
				changed = true;
			}
		}
	}
	return changed;
}

/** Drops a deleted file (or every issue in a deleted folder) from the indexes. */
export function removePath(projects: ComicProject[], path: string): boolean {
	let changed = false;
	for (const project of projects) {
		const issues = project.issues.filter((p) => p !== path && !p.startsWith(path + "/"));
		if (issues.length !== project.issues.length) {
			project.issues = issues;
			changed = true;
		}
	}
	return changed;
}

/** "Name - Issue 3", skipping names already taken in the folder. */
export function nextIssueName(project: ComicProject, taken: (basename: string) => boolean): { basename: string; number: number } {
	const number = project.issues.length + 1;
	const base = `${project.name.trim() || "Untitled"} - Issue ${number}`;
	let basename = base;
	for (let i = 2; taken(basename); i++) basename = `${base} (${i})`;
	return { basename, number };
}

/** Sorts paths the way people number files: "Issue 2" before "Issue 10". */
export function naturalSort(paths: string[]): string[] {
	return [...paths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/** Characters not allowed in file names on some system Obsidian runs on. */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- stats

export interface IssueStats {
	pages: number;
	panels: number;
	/** Words in description and freestyle blocks. */
	descriptionWords: number;
	/** Words in lettering blocks (dialogue, captions, SFX…). */
	letteringWords: number;
	/** Numbered lettering blocks: balloons, captions and SFX the letterer places. */
	balloons: number;
	/** Most lettering words in one panel. */
	busiestPanelWords: number;
	openComments: number;
	revisions: number;
	/** Balloons per speaker. */
	speakers: Map<string, number>;
}

export function emptyStats(): IssueStats {
	return { pages: 0, panels: 0, descriptionWords: 0, letteringWords: 0, balloons: 0, busiestPanelWords: 0, openComments: 0, revisions: 0, speakers: new Map() };
}

export function issueStats(doc: ComicDoc, settings: StorytellerSettings): IssueStats {
	const s = emptyStats();
	const meta = (m: { revision: boolean; notes: { resolved: boolean }[] }) => {
		if (m.revision) s.revisions++;
		s.openComments += m.notes.filter((n) => !n.resolved).length;
	};
	for (const page of doc.pages) {
		s.pages++;
		meta(page);
		for (const panel of page.panels) {
			s.panels++;
			meta(panel);
			let panelWords = 0;
			for (const block of panel.blocks) {
				meta(block);
				const type = findType(settings, block.typeId);
				const words = wordCount(plainText(block.text));
				if (type.style !== "lettering") {
					s.descriptionWords += words;
					continue;
				}
				s.letteringWords += words;
				panelWords += words;
				if (!type.numbered) continue;
				s.balloons++;
				const who = (block.speaker.trim() || type.name).toUpperCase();
				s.speakers.set(who, (s.speakers.get(who) ?? 0) + 1);
			}
			s.busiestPanelWords = Math.max(s.busiestPanelWords, panelWords);
		}
	}
	return s;
}

/** Adds `b` into `a`. */
export function addStats(a: IssueStats, b: IssueStats): IssueStats {
	a.pages += b.pages;
	a.panels += b.panels;
	a.descriptionWords += b.descriptionWords;
	a.letteringWords += b.letteringWords;
	a.balloons += b.balloons;
	a.busiestPanelWords = Math.max(a.busiestPanelWords, b.busiestPanelWords);
	a.openComments += b.openComments;
	a.revisions += b.revisions;
	for (const [who, n] of b.speakers) a.speakers.set(who, (a.speakers.get(who) ?? 0) + n);
	return a;
}
