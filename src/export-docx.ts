import {
	CommentRangeEnd,
	CommentRangeStart,
	CommentReference,
	Document,
	HighlightColor as DocxHighlight,
	ICommentOptions,
	Packer,
	Paragraph,
	ParagraphChild,
	Tab,
	TextRun,
	UnderlineType,
} from "docx";
import { parseInline } from "./format";
import { balloonNumbers, findType, pageLabel, panelLabel } from "./doc";
import { Block, ComicDoc, HighlightColor, ItemMeta, StorytellerSettings } from "./types";

/*
 * Layout follows Greg Pak's comic script template:
 * - every paragraph uses the ACTION style: 12pt Courier, 12pt space before, single spaced
 * - DIALOGUE paragraphs hang at 2": "1. CHARACTER (off):<tab>Line of dialogue"
 * - title, PAGE and "Panel N:" labels are bold; the first panel description runs on after "Panel N:"
 * - 0.75" margins on US Letter, hard page break before each new comic page
 */
const SIZE = 24; // half-points: 12pt
const TWO_INCHES = 2880; // twips

const HIGHLIGHT_MAP: Record<HighlightColor, (typeof DocxHighlight)[keyof typeof DocxHighlight]> = {
	yellow: DocxHighlight.YELLOW,
	green: DocxHighlight.GREEN,
	blue: DocxHighlight.CYAN,
	pink: DocxHighlight.MAGENTA,
	orange: DocxHighlight.DARK_YELLOW,
};

interface RunStyle {
	bold?: boolean;
	italics?: boolean;
	underline?: boolean;
	highlight?: HighlightColor | null;
}

export async function exportDocx(doc: ComicDoc, settings: StorytellerSettings): Promise<ArrayBuffer> {
	const comments: ICommentOptions[] = [];
	const balloons = balloonNumbers(doc, settings, settings.balloonScope);
	const hl = (c: HighlightColor | null | undefined) => (settings.exportHighlights && c ? HIGHLIGHT_MAP[c] : undefined);

	const run = (text: string, style: RunStyle = {}) =>
		new TextRun({
			text,
			size: SIZE,
			bold: style.bold,
			italics: style.italics,
			underline: style.underline ? { type: UnderlineType.SINGLE } : undefined,
			highlight: hl(style.highlight),
		});

	/** Turns ***bold italic***, **bold**, *italic*, __underline__ and ==highlight== (and line breaks) into runs. */
	const inlineRuns = (text: string, base: RunStyle): TextRun[] => {
		const runs: TextRun[] = [];
		for (const seg of parseInline(text)) {
			if (seg.marker) continue;
			const style: RunStyle = {
				bold: base.bold || seg.bold,
				italics: base.italics || seg.italic,
				underline: seg.underline,
				highlight: seg.highlight ? base.highlight ?? "yellow" : base.highlight,
			};
			seg.text.split("\n").forEach((line, i) => {
				if (i > 0) runs.push(new TextRun({ break: 1, size: SIZE }));
				if (line) runs.push(run(line, style));
			});
		}
		return runs;
	};

	/** Adds a red [REVISE] marker and wraps the runs in a Word comment per unresolved note. */
	const decorate = (item: ItemMeta, runs: ParagraphChild[]): ParagraphChild[] => {
		let out = runs;
		if (settings.exportRevisionMarks && item.revision) {
			out = [new TextRun({ text: "[REVISE] ", size: SIZE, bold: true, color: "C00000" }), ...out];
		}
		if (!settings.exportComments) return out;
		for (const note of item.notes) {
			if (note.resolved) continue;
			const id = comments.length;
			const author = note.author || settings.authorName;
			comments.push({
				id,
				author,
				initials: author.slice(0, 2).toUpperCase(),
				date: new Date(note.created),
				children: note.text.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
			});
			out = [new CommentRangeStart(id), ...out, new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })];
		}
		return out;
	};

	const action = (children: ParagraphChild[], pageBreakBefore = false) => new Paragraph({ style: "ACTION", pageBreakBefore, children });

	const lettering = (block: Block): Paragraph => {
		const type = findType(settings, block.typeId);
		const n = balloons.get(block.id);
		const speaker = (type.fixedSpeaker ? type.defaultSpeaker || type.name : block.speaker || type.defaultSpeaker || type.name).toUpperCase();
		const mod = block.modifier.trim() ? ` (${block.modifier.trim()})` : "";
		const label = `${n !== undefined ? n + ". " : ""}${speaker}${mod}:`;
		return new Paragraph({
			style: "DIALOGUE",
			children: decorate(block, [
				run(label, { highlight: block.highlight }),
				new TextRun({ children: [new Tab()], size: SIZE }),
				...inlineRuns(block.text, { highlight: block.highlight }),
			]),
		});
	};

	const body: Paragraph[] = [];
	body.push(action([run(doc.title.toUpperCase(), { bold: true })]));
	if (doc.byline.trim()) body.push(action([run(doc.byline.trim())]));

	doc.pages.forEach((page, pi) => {
		body.push(
			action(decorate(page, [run(pageLabel(pi, settings.pageNumberStyle), { bold: true, highlight: page.highlight })]), settings.exportPageBreaks && pi > 0)
		);

		page.panels.forEach((panel, ni) => {
			const blocks = [...panel.blocks];
			const label = run(panelLabel(ni) + "  ", { bold: true, highlight: panel.highlight });
			// The first description runs on after "Panel N:", as in the template.
			const first = blocks[0] && findType(settings, blocks[0].typeId).style === "description" ? blocks.shift()! : null;
			if (first) {
				body.push(action(decorate(panel, [label, ...decorate(first, inlineRuns(first.text, { highlight: first.highlight }))])));
			} else {
				body.push(action(decorate(panel, [label])));
			}
			for (const block of blocks) {
				if (findType(settings, block.typeId).style === "lettering") body.push(lettering(block));
				else if (block.text.trim() || block.notes.length || block.revision) {
					body.push(action(decorate(block, inlineRuns(block.text, { highlight: block.highlight }))));
				}
			}
		});
	});

	const file = new Document({
		creator: settings.authorName,
		title: doc.title,
		comments: { children: comments },
		styles: {
			default: { document: { run: { font: settings.exportFont, size: SIZE } } },
			paragraphStyles: [
				{
					id: "ACTION",
					name: "ACTION",
					basedOn: "Normal",
					quickFormat: true,
					run: { font: settings.exportFont, size: SIZE },
					paragraph: { spacing: { before: 240, after: 0 } },
				},
				{
					id: "DIALOGUE",
					name: "DIALOGUE",
					basedOn: "ACTION",
					quickFormat: true,
					paragraph: { indent: { left: TWO_INCHES, hanging: TWO_INCHES } },
				},
			],
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: 12240, height: 15840 },
						margin: { top: 1080, bottom: 1080, left: 1080, right: 1080, header: 720, footer: 720 },
					},
				},
				children: body,
			},
		],
	});
	return Packer.toArrayBuffer(file);
}
