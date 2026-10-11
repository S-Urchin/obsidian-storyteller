import { BlockType, StorytellerSettings } from "./types";

export const DEFAULT_BLOCK_TYPES: BlockType[] = [
	{ id: "description", name: "Description", color: "#7a7a7a", style: "description", numbered: false, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" },
	{ id: "dialogue", name: "Dialogue", color: "#3b82f6", style: "lettering", numbered: true, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" },
	{ id: "caption", name: "Caption", color: "#a855f7", style: "lettering", numbered: true, defaultSpeaker: "CAPTION", fixedSpeaker: true, defaultText: "" },
	{ id: "thought", name: "Thought", color: "#06b6d4", style: "lettering", numbered: true, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" },
	{ id: "sfx", name: "SFX", color: "#f97316", style: "lettering", numbered: true, defaultSpeaker: "SFX", fixedSpeaker: true, defaultText: "" },
	{ id: "freestyle", name: "Freestyle", color: "#14b8a6", style: "freestyle", numbered: false, defaultSpeaker: "", fixedSpeaker: false, defaultText: "" },
];

export const SETTINGS_SCHEMA = 5;
export const EXPORT_FOLDER = "Exported";

export const DEFAULT_SETTINGS: StorytellerSettings = {
	schema: SETTINGS_SCHEMA,
	blockTypes: DEFAULT_BLOCK_TYPES,
	presets: [],
	paletteSections: [],
	paletteWidth: 200,
	pageNavCollapsed: false,
	newPanelBlocks: ["description"],
	newPagePanels: 1,
	fontFamily: '"Courier Final Draft", "Courier Prime", "Courier New", Courier, monospace',
	fontSize: 16,
	paperMode: "auto",
	animations: true,
	pageNumberStyle: "words",
	balloonScope: "page",
	authorName: "Writer",
	exportComments: true,
	exportRevisionMarks: true,
	exportHighlights: true,
	exportPageBreaks: true,
	exportFont: "Courier New",
	exportFolder: "Exported",
	openAfterExport: false,
};

/** Palette width at which block cards switch to inline editors. */
export const WIDE_PALETTE = 300;
export const MIN_PALETTE = 150;
export const MAX_PALETTE = 560;

export const FILE_EXTENSION = "comic";
export const VIEW_TYPE_COMIC = "storyteller-comic-view";
