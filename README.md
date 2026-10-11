# Storyteller Comic Drafter

An Obsidian plugin for drafting comic scripts out of drag-and-drop blocks instead of retyping `PAGE`, `PANEL` and `CHARACTER:` over and over, then exporting the script to an editable Word file for the final pass.

Scripts are `.comic` files (JSON) that open in their own editor, not the regular Markdown view. The editor and the Word export both follow Greg Pak's comic script template:
- Courier 12pt, with one blank line before every paragraph and 0.75" margins
- a bold title and `PAGE ONE`
- `Panel 1:` running straight into its description
- dialogue written as `1. CHARACTER (off):` with the line hanging at 2"

## Features

- **Pages → panels → blocks.** Drag the grip handle (shown on hover) to reorder pages, move panels between pages, or move blocks between panels. `PAGE ONE`, `Panel 3:` and lettering balloon numbers (`1.`, `2.`…) renumber themselves whenever anything moves.
- **Block palette.** Drag *Page*, *Panel*, or any block type from the left palette into the script, or click it to add to the panel you're working in. Each panel also has a quick-add row (`+ Dialogue`, `+ SFX`…) that appears on hover.
- **Palette sections.** Organise the palette into your own sections, for example "Main cast", "Sound & FX" or "Recurring captions". Use **+ New section** to create one. Right-click a section header to rename, reorder or delete it (its blocks move to another section). Click the arrow to collapse it. To file blocks, drag them between sections, or right-click a block and choose **Move to section**. Drag a block from the script into a section to save it there as a reusable block.
- **Resizable palette that becomes an editor.** Drag the palette's right edge to resize it, or double-click the edge to switch sizes. Past 300px, each block becomes an inline editor: name, colour, layout, balloon numbering, default speaker, fixed speaker and default text for block types, and name, type, speaker and text for saved blocks. Changes apply to the script straight away. When the palette is wide, drag a card by its ⠿ grip.
- **Custom block types.** Use **+ New block type** for anything you like (radio chatter, flashback captions, editor's notes…). Pick a colour, a layout (description or lettering), whether it gets a balloon number, and a default speaker such as `CAPTION` or `SFX`. Types are saved in plugin settings and work in every script.
- **Saved blocks.** Right-click a block and choose **Save as reusable block** to keep it, content included, in the palette for reuse.
- **Collapse** pages and panels with the chevron or by double-clicking the header. Toolbar buttons collapse or expand everything at once.
- **Right-click anything** (a page heading, a panel, or a block) for **Note / Comment**, Highlight, Pin, Mark for revision, Lock, Change type, Insert below, Duplicate, Move up/down and Delete. Shift + right-click gives you the normal text menu (spellcheck, paste).
- **Comments, Google Docs style.** Choose **Note / Comment** to open a comment card in the margin to the right of the paper, level with the item you commented on. Cards can be edited (⋮ → Edit), resolved (✓) and deleted. Collapse the margin to small markers with the » button. The toolbar's comment button can also show resolved comments.
- **Lock** a page, panel or block so it can't be edited, moved or deleted. Locking a page also locks everything inside it.
- **Mark for revision.** Flagged items get a red marker and appear in the **Revise** tab of the right-hand panel.
- **Highlight** any page, panel or block in one of five colours.
- **Pin** items to the **Pinned** tab so you can jump to them in one click.
- **Speaker field.** Type `MAYA (off)` and the plugin splits it into the speaker and the modifier. Names autocomplete from the ones already in the script. For SFX and CAPTION blocks, type the modifier in brackets: `SFX (BIG)`.
- **Animations.** New items fade in, moved and reordered items glide to their new place, deleted items fade out, and comment cards slide in from the margin. They animate only what changed and use the cheapest kind of animation, so long scripts stay responsive. Turn them off in *Settings → Animations*. They are always off if your system has reduced motion turned on.
- **Dark mode.** Choose dark paper with light text, or light paper. **Auto** (the default) follows Obsidian's light/dark theme as you switch it. Click the sun/moon button in the toolbar to flip between light and dark, and right-click it to go back to Auto. You can also set it under *Settings → Paper style*. The Word export always uses normal black-on-white.
- **Undo/redo** with Ctrl+Z / Ctrl+Shift+Z when the cursor isn't in a text field.
- **Export to Word.** Click **Export .docx** to save `<script name>.docx` in an **Exported** folder at the root of your vault; the folder is created the first time you export. Click the notice that appears to see the file in your file manager. You can change the folder in settings, or clear the setting to save next to each script. The export includes:
  - the template's layout, including its `ACTION` and `DIALOGUE` paragraph styles, so the file stays easy to edit in Word, with a page break before each comic page;
  - unresolved comments as Word margin comments;
  - a red `[REVISE]` before flagged items;
  - your highlights, with `**bold**`, `*italic*` and `==highlight==` in block text formatted to match.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl/Cmd + Enter | New block of the same type below |
| Ctrl/Cmd + Shift + Enter | New panel below |
| Ctrl/Cmd + Z / Shift + Z | Undo / redo (outside text fields) |

The command palette also has *New comic script*, *Export current script to Word*, *Add page*, *Collapse all pages* and *Expand all pages and panels*.

## Install (manual)

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/storyteller-comic-drafter/`, then enable **Storyteller Comic Drafter** under *Settings → Community plugins*.

For development, run `npm run dev` to rebuild on save.

Create a script from the ribbon's book icon, the *New comic script* command, or by right-clicking a folder.

## Tips

- Obsidian hides `.docx` files in its file list unless *Settings → Files and links → Detect all file extensions* is on. Your exports are still in the `Exported` folder either way. Click the export notice to open the folder.

- The editor uses Courier Final Draft or Courier Prime if either is installed, and Courier New otherwise. The Word file uses Courier New by default; change it to Courier Final Draft under *Settings → Word font* to match the template exactly.
- Hovering over a panel shows its lettering word count, which turns red above 35 words as a hint that the panel is getting crowded.
- Drag and drop needs a mouse. On touch devices, right-click (long-press) and use **Move up / Move down** instead.
- Scripts made with v0.1 that contain "Note to artist" blocks are converted automatically: each note becomes a comment on its panel.
