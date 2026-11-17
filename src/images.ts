import type { Block, BlockImage, ComicDoc, Page, Panel } from "./types";

export type ImageType = "png" | "jpg" | "gif" | "bmp";

export function imageType(extension: string): ImageType | null {
	switch (extension.toLowerCase()) {
		case "png": return "png";
		case "jpg":
		case "jpeg": return "jpg";
		case "gif": return "gif";
		case "bmp": return "bmp";
		default: return null;
	}
}

/** A block's image from a file, or undefined if it isn't one. */
export function loadBlockImage(value: unknown): BlockImage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const image = value as Record<string, unknown>;
	if (typeof image.path !== "string" || !image.path) return undefined;
	return {
		path: image.path,
		alt: typeof image.alt === "string" ? image.alt : "",
		hidden: image.hidden === true,
	};
}

export function fileName(path: string): string {
	return path.split("/").pop() ?? path;
}

/** Fits an image inside the Word text area without stretching or enlarging it. */
export function fitImage(width: number, height: number): { width: number; height: number } {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error("The image has invalid dimensions.");
	}
	const scale = Math.min(1, 672 / width, 864 / height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** True if `path` is `target` or inside the folder `target`. */
export function pathMatches(path: string, target: string): boolean {
	return path === target || path.startsWith(target + "/");
}

export function renameImage(image: BlockImage | undefined, oldPath: string, newPath: string): boolean {
	if (!image || !pathMatches(image.path, oldPath)) return false;
	image.path = newPath + image.path.slice(oldPath.length);
	return true;
}

export function renameDocImages(doc: ComicDoc, oldPath: string, newPath: string): boolean {
	let changed = false;
	for (const page of doc.pages) for (const panel of page.panels) for (const block of panel.blocks) {
		if (renameImage(block.image, oldPath, newPath)) changed = true;
	}
	return changed;
}

export function docHasImages(doc: ComicDoc): boolean {
	return doc.pages.some((page) => page.panels.some((panel) => panel.blocks.some((block) => !!block.image)));
}

export interface PanelImages {
	page: Page;
	panel: Panel;
	pageIndex: number;
	panelIndex: number;
	/** The panel's blocks that have an image, in order. */
	blocks: Block[];
}

/** Every panel with block images, in reading order (for the Word appendix). */
export function panelsWithImages(doc: ComicDoc): PanelImages[] {
	const out: PanelImages[] = [];
	doc.pages.forEach((page, pageIndex) =>
		page.panels.forEach((panel, panelIndex) => {
			const blocks = panel.blocks.filter((block) => !!block.image);
			if (blocks.length) out.push({ page, panel, pageIndex, panelIndex, blocks });
		})
	);
	return out;
}
