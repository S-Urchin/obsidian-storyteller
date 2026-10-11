/** Highlight colours available for any page, panel or block. */
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "orange";

export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink", "orange"];

export interface SideNote {
	id: string;
	text: string;
	author: string;
	created: number;
	resolved: boolean;
}

/** State shared by pages, panels and blocks. */
export interface ItemMeta {
	id: string;
	locked: boolean;
	revision: boolean;
	pinned: boolean;
	highlight: HighlightColor | null;
	notes: SideNote[];
}

/**
 * How a block type is laid out in the editor and in the Word export.
 * - description: full-width prose (panel descriptions, scene directions)
 * - lettering: "1. SPEAKER (modifier):<tab>text" — dialogue, captions, SFX, thoughts
 */
export type BlockStyle = "description" | "lettering";

export interface BlockType {
	id: string;
	name: string;
	color: string;
	style: BlockStyle;
	/** Lettering blocks only: counts toward the balloon number (1., 2., ...). */
	numbered: boolean;
	/** Lettering blocks only: speaker pre-filled when the block is created, e.g. "CAPTION" or "SFX". */
	defaultSpeaker: string;
	/** Lettering blocks only: if true the speaker is fixed to defaultSpeaker and hidden from editing. */
	fixedSpeaker: boolean;
	/** Text pre-filled when the block is created. */
	defaultText: string;
}

/** A saved block with content, reusable from the palette. */
export interface BlockPreset {
	id: string;
	name: string;
	typeId: string;
	speaker: string;
	modifier: string;
	text: string;
}

/** A user-defined group in the block palette. Items are "type:<id>" or "preset:<id>". */
export interface PaletteSection {
	id: string;
	name: string;
	collapsed: boolean;
	items: string[];
}

export interface Block extends ItemMeta {
	typeId: string;
	speaker: string;
	modifier: string;
	text: string;
}

export interface Panel extends ItemMeta {
	collapsed: boolean;
	blocks: Block[];
}

export interface Page extends ItemMeta {
	collapsed: boolean;
	panels: Panel[];
}

export interface ComicDoc {
	format: "storyteller-comic";
	version: 1;
	title: string;
	/** Line under the title, e.g. "10.11.26 - by Your Name - you@example.com". */
	byline: string;
	pages: Page[];
}

export type ItemKind = "page" | "panel" | "block";

export interface ItemRef {
	kind: ItemKind;
	item: Page | Panel | Block;
	page: Page;
	panel?: Panel;
	block?: Block;
	pageIndex: number;
	panelIndex?: number;
	blockIndex?: number;
}

export type PaperMode = "auto" | "light" | "dark";
export type PageNumberStyle = "digits" | "words";
export type BalloonScope = "page" | "panel" | "off";

export interface StorytellerSettings {
	/** Bumped when saved settings need migrating. */
	schema: number;
	blockTypes: BlockType[];
	presets: BlockPreset[];
	paletteSections: PaletteSection[];
	/** Palette column width in px; wide enough and blocks become editable in place. */
	paletteWidth: number;
	/** Block type ids added to every new panel. */
	newPanelBlocks: string[];
	/** Number of panels added to a new page. */
	newPagePanels: number;
	fontFamily: string;
	fontSize: number;
	/** Paper colours: follow Obsidian's theme, or always light / always dark. */
	paperMode: PaperMode;
	animations: boolean;
	pageNumberStyle: PageNumberStyle;
	balloonScope: BalloonScope;
	authorName: string;
	exportComments: boolean;
	exportRevisionMarks: boolean;
	exportHighlights: boolean;
	exportPageBreaks: boolean;
	exportFont: string;
	exportFolder: string;
	openAfterExport: boolean;
}
