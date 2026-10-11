import { uid } from "./doc";
import { PaletteSection, StorytellerSettings } from "./types";

export const typeKey = (id: string) => "type:" + id;
export const presetKey = (id: string) => "preset:" + id;

export function newSection(name: string): PaletteSection {
	return { id: uid(), name, collapsed: false, items: [] };
}

/**
 * Keeps palette sections in step with the block types and saved blocks: drops entries for
 * deleted items and duplicates, and files anything new under "Blocks" / "Saved blocks"
 * (or the first section if the user removed those).
 */
export function ensureSections(s: StorytellerSettings) {
	if (!Array.isArray(s.paletteSections) || !s.paletteSections.length) {
		s.paletteSections = [
			{ id: "blocks", name: "Blocks", collapsed: false, items: [] },
			{ id: "saved", name: "Saved blocks", collapsed: false, items: [] },
		];
	}
	const valid = new Set([...s.blockTypes.map((t) => typeKey(t.id)), ...s.presets.map((p) => presetKey(p.id))]);
	const seen = new Set<string>();
	for (const sec of s.paletteSections) {
		sec.items = sec.items.filter((k) => {
			if (!valid.has(k) || seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	}
	s.quickAdd = [...new Set(s.quickAdd ?? [])].filter((k) => valid.has(k));
	const home = (id: string) => s.paletteSections.find((x) => x.id === id) ?? s.paletteSections[0];
	for (const t of s.blockTypes) if (!seen.has(typeKey(t.id))) home("blocks").items.push(typeKey(t.id));
	for (const p of s.presets) if (!seen.has(presetKey(p.id))) home("saved").items.push(presetKey(p.id));
}

export function sectionOf(s: StorytellerSettings, key: string): PaletteSection | undefined {
	return s.paletteSections.find((sec) => sec.items.includes(key));
}

/** Moves an item to `index` in `target`, wherever it currently is. */
export function moveToSection(s: StorytellerSettings, key: string, target: PaletteSection, index: number) {
	const from = sectionOf(s, key);
	if (from) {
		const i = from.items.indexOf(key);
		if (from === target && i < index) index--;
		from.items.splice(i, 1);
	}
	target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, key);
}

export const isStarred = (s: StorytellerSettings, key: string) => s.quickAdd.includes(key);

export function toggleStar(s: StorytellerSettings, key: string) {
	s.quickAdd = isStarred(s, key) ? s.quickAdd.filter((k) => k !== key) : [...s.quickAdd, key];
}

/** Starred items in the order they appear in the palette. */
export function starredItems(s: StorytellerSettings): string[] {
	return s.paletteSections.flatMap((sec) => sec.items).filter((k) => isStarred(s, k));
}
