# Vellum

A minimal Figma-style vector editor that runs in the browser. There is no build step and no dependencies: three files (`index.html`, `core.js`, `app.js`) make up the whole app.

## What it does

- **Pages and layers.** A layers tree with show/hide and lock, reordering with ⌘[ and ⌘], and inline renaming.
- **Tools.** Move, hand, rectangle, ellipse, text and connector arrows, plus groups, sections and multi-path vector nodes.
- **Editing.** Double-click steps into a group, ⌘-click selects the deepest layer, marquee selection, resize handles, nudging, align, duplicate, copy and paste, undo and redo.
- **Properties panel.** Position, size, opacity, fill, stroke, corner radius, text (size, weight, line height, colour, alignment, wrapping) and connector settings.
- **Files.** Documents are plain JSON. Open and save from the File menu; the current document autosaves to `localStorage`.
- **Export.** The selection or the whole page as SVG or PNG. SVG exports can embed the Inter font so they render the same offline.
- **Phones.** The tools move to a floating bar and two-finger pinch zooms.

## Run it locally

```bash
python3 tools/devserver.py 8765
```

Then open http://127.0.0.1:8765. The dev server serves the app and also accepts `POST /save?name=<file>` to write exports into `exports/`.

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

Every node has `id`, `type` and `name`, and uses absolute page coordinates. Node types:

- `RECT`, `ELLIPSE`: `x y w h fill fillOpacity stroke strokeWidth radius`
- `TEXT`: `x y text fontSize fontWeight color lineHeight align autoWidth w`, plus optional coloured `runs`
- `PATH`: `x y w h vw vh fill stroke detail strokeWidth paths[{d, role}]`, where role is `body`, `ink` or `dot`
- `GROUP`: `children` (bounds come from the children)
- `SECTION`: `x y w h fill stroke radius children`
- `CONNECTOR`: `from{id, side} to{id, side} label stroke strokeWidth dash arrow`

## Code layout

- `core.js` holds the document helpers, text layout, bounds, SVG rendering and export. It has no DOM dependency apart from an injected text measurer, so the editor and headless exporters share it.
- `app.js` is the editor: state, pointer and keyboard handling, panels, history and files.
- `tools/devserver.py` is the local static server with the export save endpoint.

The browser console exposes `window.vellum` (`doc`, `selection`, `select`, `mutate`, `exportSVG`) for scripting.
