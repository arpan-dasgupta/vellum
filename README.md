# Vellum

A minimal Figma-style vector editor that runs in the browser. There is no build step and no dependencies: three files (`index.html`, `core.js`, `app.js`) make up the whole app.

This repo also holds diagrams made with Vellum. They live in `diagrams/`, apart from the app, and the app knows nothing about them. Notes for working on either with Claude are in `CLAUDE.md`.

## What it does

- **Pages and layers.** A layers tree with show/hide and lock, reordering with ⌘[ and ⌘], and inline renaming.
- **Tools.** Move, hand, rectangle, ellipse, text and connector arrows, plus groups, sections and multi-path vector nodes.
- **Editing.** Double-click steps into a group, ⌘-click selects the deepest layer, marquee selection, resize handles, nudging, align, duplicate, copy and paste, undo and redo.
- **Properties panel.** Position, size, opacity, fill, stroke, corner radius, text (size, weight, line height, colour, alignment, wrapping) and connector settings.
- **Files.** Documents are plain JSON. Open and save from the File menu; the current document autosaves to `localStorage`.
- **Export.** The selection or the whole page as SVG or PNG. SVG exports can embed the Inter font so they render the same offline.
- **Annotations.** Sketches, arrows, highlights and sticky notes, in five colours, in their own "Annotations" layer on each page.
  - **Sketches.** While the pen is active, every stroke joins one sketch, so a drawing of several strokes is one annotation. Press Done or Esc to finish, or New sketch to start another. A sketch means "I want something like this" by default; switch it to "Points at something" when it just marks a spot.
  - **Arrows.** Ends stick to the layer under them: small layers snap to their centre, big ones keep the exact point. Hold Alt for a free end. Right-drag draws one from any tool.
  - **Highlights.** Click to highlight the most specific layer under the pointer, or drag to highlight an area. Right-click highlights from any tool.
  - **Combining.** Select several annotations and press ⌘G, or "Combine into one annotation", to make them one annotation with one thread.
- **Images.** Drop, paste or place images (File › Place image…). They're stored inside the document, and animated GIFs play on the canvas.
- **Phones.** The tools move to a floating bar and two-finger pinch zooms.

## Run it locally

```bash
python3 tools/devserver.py 8765
```

Then open http://127.0.0.1:8765. The dev server serves the app and also accepts `POST /save?path=<file>`, which the render pages use to write files. It only writes `.svg`, `.png`, `.gif` and `.json` files inside a folder named `exports` or under `.tmp/`.

### The starting document

`vellum.config.json` names the document the editor opens when there is no autosaved copy:

```json
{ "startDocument": "diagrams/fog-of-war/fog-of-war.json" }
```

File › Load reopens it. If the document has a `sample` tag and a higher `sampleVersion` than an autosaved copy with the same tag, the editor loads the new version and keeps the old copy a single undo away.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Move, hand | V, H |
| Rectangle, ellipse | R, O |
| Text, connector | T, C |
| Group, ungroup | ⌘G, ⇧⌘G |
| Duplicate | ⌘D |
| Bring forward, send backward | ⌘], ⌘[ |
| Hide, lock | ⇧⌘H, ⇧⌘L |
| Zoom to fit, zoom to selection, 100% | ⇧1, ⇧2, ⇧0 |
| Pen, arrow, highlight, note | P, A, M, N |
| Arrow, highlight from any tool | Right-drag, right-click |
| Combine selected annotations | ⌘G |
| Undo, redo | ⌘Z, ⇧⌘Z |

## Document format

```json
{
  "version": 1,
  "name": "Untitled",
  "pages": [
    { "id": "page-1", "name": "Page 1", "children": [
      { "id": "r1", "type": "RECT", "name": "Box", "x": 0, "y": 0, "w": 100, "h": 100, "fill": "#D9D9D9" }
    ] }
  ]
}
```

Every node has `id`, `type` and `name`, and uses absolute page coordinates. A document built by a script can also carry `sample` (a tag naming it) and `sampleVersion`, which the editor uses to replace older autosaved copies. Node types:

- `RECT`, `ELLIPSE`: `x y w h fill fillOpacity stroke strokeWidth radius`
- `TEXT`: `x y text fontSize fontWeight color lineHeight align autoWidth w`, plus optional coloured `runs`
- `PATH`: `x y w h vw vh fill stroke detail strokeWidth paths[{d, role}]`, where role is `body`, `ink` or `dot`
- `GROUP`: `children` (bounds come from the children)
- `SECTION`: `x y w h fill stroke radius children`
- `CONNECTOR`: `from{id, side} to{id, side} label stroke strokeWidth dash arrow headSize`
- `INK`: `strokes[{points, stroke, strokeWidth}] stroke strokeWidth intent` (a sketch; `intent` is `mockup` or `mark`)
- `STICKY`: `x y w h text fill fontSize` (note; height grows with the text)
- `IMAGE`: `x y w h src` (`src` is a data URI)

## Sharing annotations

When Vellum runs as a published Claude artifact, each page's annotations sync to the artifact's database as `annotations/<pageId>`. Every item carries an `about` line in plain language, such as "red arrow from square f6 on “Position 2” to square e4", so Claude can read what each mark points at. Run locally, annotations stay in the browser's autosave.

Each annotation is also a small thread. Select one to add follow-ups, then resolve it when the work is done; a follow-up on a resolved annotation reopens it. Resolved annotations are hidden from the canvas and from exports, and stay listed under Resolved in the side panel, where "Show on canvas" brings them back faded. In the shared data, items carry `status: "resolved"`, `resolvedBy` and a `replies` list of `{author, text, at}`, with `author` either `user` or `claude`, so Claude can post follow-ups and resolve items too.

## Working on annotations with Claude

1. Open the published Vellum and mark up what you want: sketch it with the pen, point with arrows and highlights, and write instructions in notes.
2. Ask Claude to work on the annotations. It reviews each open annotation on its own, as an image, before changing anything.
3. Claude replies on each annotation with what it changed and resolves it. If something is unclear, it asks on that annotation and leaves it open.
4. To ask for more, add a follow-up on the annotation; that reopens it for the next round.

The step-by-step process Claude follows is in `CLAUDE.md`.

## Batch export

With the dev server running, `export.html?jobs=<jobs.json>` renders layers to SVG and PNG in the browser and saves them. A jobs file looks like this:

```json
{
  "doc": "my-diagram.json",
  "out": "exports",
  "jobs": [
    { "nodes": ["section-1"], "file": "overview", "pad": 0, "scale": 1 },
    { "nodes": ["panel-3"], "file": "panel-3", "pad": 24, "bg": "#F9F9F9", "scale": 2 }
  ]
}
```

`doc` and `out` are relative to the jobs file. Each job renders the listed layers into `<out>/<file>.svg` and `<out>/<file>.png`, with optional padding, background and PNG scale. SVGs embed the Inter font when it can be fetched.

`export.html?review=<annotations.json>` renders each open annotation on its own, for reviewing annotations; `CLAUDE.md` describes it.

## Code layout

- **The app.**
  - `core.js` holds the document helpers, text layout, bounds, SVG rendering and export. It has no DOM dependency apart from an injected text measurer, so the editor and the render pages share it.
  - `app.js` is the editor: state, pointer and keyboard handling, panels, history, files and annotation sync.
  - `export.html` is the batch export and review page.
  - `tools/devserver.py` is the local static server with the save endpoint.
  - `tools/make_gif.py` packs PNG frames into an animated GIF, with only the Python standard library.
- **Settings.** `vellum.config.json` names the starting document.
- **Diagrams.** `diagrams/<name>/` holds each diagram: its build script, document, export jobs, assets, exports and README.

The browser console exposes `window.vellum` (`doc`, `selection`, `select`, `mutate`, `exportSVG`) for scripting.

## Diagrams

Diagrams made with Vellum live in `diagrams/`, one folder each. A folder holds the diagram's build script, its document, its export jobs, its rendered exports and a README explaining it. None of it is part of the app.

- **[Fog of War](diagrams/fog-of-war/README.md).** A Fog of War chess game drawn to show how a model plays with hidden information. It covers next-observation prediction, embeddings aligned with the real state, and sampling of candidate histories for hidden moves. It is the editor's starting document.

![The Fog of War diagram, White's view](diagrams/fog-of-war/exports/whites-view-all.png)
