# Vellum: notes for Claude

Vellum is a general-purpose vector editor. The Fog of War chess boards are one sample document, not the product.

- Keep `index.html`, `core.js` and `app.js` free of sample-specific logic. Anything about chess belongs in `tools/build_fow.py`.
- Run locally with `python3 tools/devserver.py 8765` and open http://127.0.0.1:8765. The dev server also accepts `POST /save?name=<file>` to write into `exports/`.
- The published copy is a private Claude artifact: https://claude.ai/artifact/ATX36qp23R7zF8i4GU5nAd. Republish `index.html` with `core.js`, `app.js` and `samples/fog-of-war.json` as supporting files. It declares the `downloads` and `db` capabilities; a republish carries them forward.

## Working on annotations

The user marks up the published Vellum with sketches, arrows, highlights and notes, then asks Claude to work on them. Each page's annotations live in the artifact database at `annotations/<pageId>`; the README describes the item format.

Work through them like this:

1. **Fetch.** Read `annotations/<pageId>` with ArtifactData (`get` with `out_dir`) and copy the file to `.tmp/ann.json` (git-ignored). Open items are those without `status: "resolved"`. A user follow-up on a resolved item reopens it.
2. **Look before acting, one annotation at a time.** Open `http://127.0.0.1:8765/export.html?preset=review&ann=.tmp/ann.json`. It writes `exports/_review-<run>-<name>.png`: one image per open annotation, showing only that annotation over the diagram, labelled with its name. Convert each to JPEG before viewing (`sips -s format jpeg <png> --out <jpg>`); image viewers can show a stale copy of a re-rendered PNG. Understand the drawing from the image, not from stroke coordinates.
3. **Read the intent.** A sketch (`INK`) means "I want something like this" unless its `intent` is `mark`, which means it points at something. A note's text is the instruction. Annotations combined into a set belong together.
4. **When unsure, ask on the annotation.** Build the most likely reading, reply on that annotation with the specific question, and leave it open.
5. **Make the change.** Diagram changes go in `tools/build_fow.py`; bump `SAMPLE_VERSION` so autosaved copies pick up the new sample, and rebuild with `python3 tools/build_fow.py`. Editor changes go in `app.js` and `core.js`, and stay generic.
6. **Check it.** Re-render with `&bare=1` to see the result without the annotation on top, and compare it with the annotation's own image. Regenerate exports with `export.html?preset=fow`.
7. **Publish, then reply and resolve.** Republish the artifact. For each handled item, set `status: "resolved"`, `resolvedBy: "claude"` and `resolvedAt`, and append a reply `{id, author: "claude", text, at}` saying what changed. Refresh the document's `summary`, `open`, `count` and `updatedAt`. Write with ArtifactData `update`, pinned with `if_version` to the version you read. On `version_mismatch` the user is probably editing live: re-read, redo the change on the new copy, and retry. Never force a write.
8. **Report back** in chat: what changed, what's still open, and any question you left on an annotation.

## Commits

Commit editor changes and diagram changes separately. Never commit `.tmp/` or `exports/_*` (review images); both are git-ignored. Only commit when the user asks.
