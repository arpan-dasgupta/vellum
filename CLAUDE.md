# Vellum: notes for Claude

Vellum is a general-purpose vector editor that runs in the browser with no build step. This repo holds the editor and, separately, the diagrams made with it. Everything needed to use and change both is written down here and in each diagram's README, so a new session can start without earlier context.

## The app and the diagrams are separate

| Part | Files | What it knows |
| --- | --- | --- |
| The app | `index.html`, `core.js`, `app.js`, `export.html`, `tools/devserver.py`, `tools/make_gif.py` | Only generic editing. It never names a diagram, a node id or anything about a diagram's subject. |
| Deployment setting | `vellum.config.json` | Which document the editor opens first (`startDocument`). |
| Each diagram | `diagrams/<name>/` | Everything about that diagram: its build script, document, export jobs, assets, rendered exports and its own README. |

- When a diagram needs something the editor can't do, add a general feature to the app, such as images or multi-stroke sketches, then use it from the diagram's build script. Never special-case a diagram in the app.
- A diagram folder holds:
  - `README.md`, with what the diagram shows, the decisions behind it and how to change it.
  - `build.py`, which writes the document.
  - `<name>.json`, the Vellum document. It is generated, so never edit it by hand.
  - `export-jobs.json`, which the build script writes, listing what `export.html` renders.
  - `exports/`, the rendered SVG and PNG files, which are committed.
  - `assets/`, the files the build script embeds.
- There is one diagram so far, `diagrams/fog-of-war/`. Read its README before changing it.

## Running things

- **Dev server.** Start `python3 tools/devserver.py 8765` in the background and open http://127.0.0.1:8765. It serves the repo. It also accepts `POST /save?path=<file>` for `.svg`, `.png`, `.gif` and `.json` files inside a folder named `exports` or under `.tmp/`, which is how the render pages write files. Restart it after changing `tools/devserver.py`.
- **A browser for render pages.** `export.html` renders in the browser and then saves through the dev server. Headless Chrome hung inside the sandboxed Claude Code environment, so use the Claude desktop app's built-in browser pane. Navigate to the page, then wait for it with the JavaScript tool:

  ```js
  for (let i = 0; i < 60 && !document.body.dataset.done; i++) await new Promise(r => setTimeout(r, 1000)); document.getElementById('log').textContent
  ```

  `done` becomes `"1"` on success or `"error"`, and the log says what was written.
- **Scripting the editor.** In the editor's console, `window.vellum` exposes `doc`, `selection`, `select`, `mutate` and `exportSVG`.
- **Scratch files** go in `.tmp/`, which is git-ignored. Review images land in `.tmp/review/`.

## Looking at renders

- **Convert before viewing.** Image viewers can show a stale copy of a PNG that was just re-rendered. Always convert to a new JPEG name before looking: `sips -s format jpeg -Z 1600 <png> --out .tmp/<new-name>.jpg`.
- **Check details at full size.** Crop any region you changed: `sips -s format jpeg -c <height> <width> --cropOffset <y> <x> <png> --out .tmp/<name>.jpg`. The whole-page view is too small to judge text, spacing or overlaps.
- **Check for side effects.** After re-exporting, `git status` on the diagram's `exports/` shows which renders changed. A page you didn't mean to touch should show no change. If it does, a constant is shared between pages. This happened once when board spacing widened on both pages of the Fog of War diagram.
- **Check the SVGs parse.** A bare `&` once made an export invalid:

  ```bash
  python3 -c "import sys, xml.dom.minidom as m; [m.parse(f) for f in sys.argv[1:]]; print('ok')" diagrams/*/exports/*.svg
  ```

## Changing a diagram

1. Edit `diagrams/<name>/build.py`.
2. Bump `SAMPLE_VERSION` in it whenever the output changes. Browsers that autosaved an older copy then load the new one, and their old copy stays one ⌘Z away. The version travels in the document as `sampleVersion`, next to a `sample` tag naming the diagram.
3. Rebuild with `python3 diagrams/<name>/build.py`. That also rewrites `export-jobs.json`.
4. Re-export by opening `http://127.0.0.1:8765/export.html?jobs=diagrams/<name>/export-jobs.json` and waiting for `done`.
5. Look at the result as described above, including full-size crops of everything you changed.
6. Republish the artifact so the published copy matches, as described under "The published copy".
7. Show the user the main PNG inline and attach the SVG.

What the user expects from diagrams in general:

- **Labels.** Labels must be clean and readable in a clear font, and sit in free space with room around them. Make room by moving things apart rather than letting a label overlap anything. A label takes the colour of the thing it names.
- **Separate styling.** Keep text off arrows unless asked. Give each kind of arrow its own colour.
- **Alignment.** Place things exactly: centred in their cells and aligned to their neighbours.
- **Ambiguous requests.** When a request's numbers don't add up, such as "remove the last two boards" leaving six when the user said five, ask before building.

## Changing the app

- Keep it generic, as above, and keep it dependency-free. `core.js` has no DOM dependency apart from an injected text measurer. `app.js` is the editor UI.
- `index.html` starts at `<title>` with no `<html>` or `<body>` tags. The artifact host wraps the page itself, and the dev server wraps it the same way locally. Keep it that way.
- Test in the browser pane: load the editor, use the feature, and check `read_console_messages` for errors.

## The published copy

The user's Vellum runs as a private Claude artifact: https://claude.ai/artifact/ATX36qp23R7zF8i4GU5nAd. It declares the `db` capability for annotations and `downloads` for exports. On republish, leave `capabilities` out so they carry forward.

To republish:

1. List what is published: Artifact `action: "list"`, `scope: "files"`, with the URL.
2. Publish with Artifact, passing:
   - `url`, the artifact URL;
   - `file_path`, the local `index.html`;
   - `files`, a map from each published path to a local path: `core.js`, `app.js`, `vellum.config.json`, and the document `startDocument` points to, at that same relative path.
3. Map any published path that no longer exists to `null`.

The page fetches `vellum.config.json` and the document from beside itself, so the published paths must match the repo's.

## Working on annotations

The user marks up the published Vellum with sketches, arrows, highlights and notes, then asks Claude to work on them. Each page's annotations live in the artifact database, collection `annotations`, document id = the page id (for example `page-view`). ArtifactData is a deferred tool; load it with ToolSearch (`select:ArtifactData`) first.

The document holds:

- `pageId`, `pageName`, `updatedAt`, `count` and `open`.
- `summary`: one line per item, `OPEN · <about>` or `RESOLVED · <about>`, followed by ` · follow-ups: Claude: … | User: …` when the item has replies.
- `items`: the annotation nodes themselves. Their types are `INK` sketches, `CONNECTOR` arrows, highlight shapes, `STICKY` notes and `GROUP`s for combined sets. Each carries:
  - `about`, a plain-language line saying what it is and what it points at;
  - `status`, which is `"resolved"` once it's done;
  - `resolvedBy` and `resolvedAt`;
  - `replies: [{id, author: "claude" | "user", text, at}]`.

Work through them like this:

1. **Fetch.** ArtifactData `get` with the artifact `url`, `collection: "annotations"`, `doc_id: "<pageId>"` and an `out_dir` in the scratchpad. Note the version it reports, then copy the saved file to `.tmp/ann.json`. Open items are those without `status: "resolved"`. A user follow-up on a resolved item reopens it.
2. **Look before acting, one annotation at a time.** Open `http://127.0.0.1:8765/export.html?review=.tmp/ann.json`. It writes `.tmp/review/<run>-<name>.png`, one image per open annotation, showing only that annotation over the diagram and labelled with its name. Convert each to JPEG and view them one by one. Understand each drawing from its image, not from stroke coordinates.
3. **Read the intent.**
   - A sketch (`INK`) means "I want something like this", unless its `intent` is `mark`, which means it points at something.
   - A note's text is the instruction.
   - Annotations combined into a set belong together.
4. **When unsure, ask on the annotation.** Build the most likely reading, reply on that annotation with the specific question, and leave it open.
5. **Make the change,** following "Changing a diagram" or "Changing the app".
6. **Check it.** Re-render with `&bare=1` to see the result without the annotation on top, and compare it with the annotation's own image.
7. **Publish, then reply and resolve.**
   - Republish the artifact.
   - For each handled item, set `status: "resolved"`, `resolvedBy: "claude"` and `resolvedAt`.
   - Append a reply `{id, author: "claude", text, at}`. The text starts with "Done in version <SAMPLE_VERSION>." and says concretely what changed, with sizes where they help.
   - Recompute `summary`, `open`, `count` and `updatedAt`.
   - Write with ArtifactData `update`: the same `collection` and `doc_id`, a `file_path` to a JSON file with the changed fields, and `if_version` set to the version you fetched. On `version_mismatch` the user is probably editing live. Re-fetch, redo the change on the new copy and retry. Never force a write.
8. **Report back** in chat: what changed, what's still open, and any question left on an annotation.

## Assets

- **Bitmaps.** A diagram's bitmap assets live in `diagrams/<name>/assets/` and are embedded into the document as data URIs by its build script.
- **Animated GIFs.** Draw the frames in a page in the diagram folder, which saves them to `.tmp/`. Then pack them with `python3 tools/make_gif.py <out.gif> <frames…>`, which needs only the Python standard library.

## Commits and pushes

- Commit only when the user asks, and push only when they ask. The remote is `origin` (GitHub `arpan-dasgupta/vellum`, private), branch `main`.
- Keep app changes and diagram changes in separate commits. A diagram commit touches only `diagrams/<name>/`, plus a line in the README's diagram list when one is added. An app commit touches the app files and the root docs.
- Commit subjects are sentence-case imperatives with no prefix, such as "Trim White's view to five boards and enlarge the labels". The body says what changed and why.
- Never commit `.tmp/`.
