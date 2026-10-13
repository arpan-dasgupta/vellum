# Vellum

![Vellum: a sketched annotation above the change Claude made from it](docs/cover.png)

Vellum is a small vector editor that runs in the browser: three files, no build step and no dependencies. You draw diagrams, export them as SVG or PNG, and mark them up with sketches and notes that Claude reads and works through.

## Features

- **Diagrams.** Rectangles, ellipses, text, vector paths, images and connector arrows, organised in pages, layers, groups and sections.
- **Annotations.** Sketch what you want, point with arrows, highlight layers and leave notes, all in their own layer. Each annotation is a small thread you can reply to and resolve.
- **Readable by Claude.** Each annotation carries a plain-language description of what it points at, so Claude knows what a mark refers to.
- **Export.** Export a selection or a whole page as SVG, with the Inter font embedded, or as PNG. A batch exporter renders many at once.
- **Plain JSON documents.** They are easy to generate from a script and easy to diff.

## Quick start

```bash
git clone https://github.com/arpan-dasgupta/vellum.git
cd vellum
python3 tools/devserver.py 8765
```

Then open http://127.0.0.1:8765. Python 3 is the only requirement.

## Working with Claude

1. **Mark up the diagram.** Sketch what you want with the pen (P), point with arrows (A) and highlights (M), and write instructions in notes (N).
2. **Ask Claude to work on the annotations.** Claude looks at each one on its own, as an image, and makes the change. Then it replies on the annotation and resolves it.
3. **Answer questions on the annotation.** If something is unclear, Claude asks there and leaves the annotation open. Reply on it to continue.

Annotations reach Claude when Vellum is published as a Claude artifact: they sync to the artifact's database, where Claude reads them and replies. Run locally, they stay in the browser's autosave and in saved files. [CLAUDE.md](CLAUDE.md) is the guide Claude follows.

The cover shows a real round. The note and red sketch asked for a three-sided rail with rounded corners instead of tilted arrows. The panel below shows what Claude built.

## Example: Fog of War

[`diagrams/fog-of-war`](diagrams/fog-of-war/README.md) is a complete diagram made with Vellum. It draws a Fog of War chess game to show how a model plays with hidden information. A Python script generates it, and it was shaped through about thirty annotations.

![The Fog of War diagram](diagrams/fog-of-war/exports/whites-view-all.png)

## Repository layout

| Path | What it holds |
| --- | --- |
| `index.html`, `core.js`, `app.js` | The editor |
| `export.html` | Batch export and annotation review |
| `tools/` | The dev server and a GIF packer |
| `vellum.config.json` | Which document opens first |
| `diagrams/` | Diagrams made with Vellum, one self-contained folder each |
| `docs/` | The [reference](docs/reference.md) and images |

The editor never refers to a diagram. Anything specific to one diagram lives in its own folder.

## License

[MIT](LICENSE)
