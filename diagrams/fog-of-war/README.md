# Fog of War diagram

A Fog of War chess game drawn as Vellum layers. It shows how a model might play a game with hidden information:

1. **Prediction.** It predicts the next observation.
2. **Alignment.** It aligns its representations with the real state.
3. **Learning.** It learns a policy and a value function through RL self-play.
4. **Sampling.** For each hidden move, it samples candidate histories.

Everything in this folder belongs to the diagram. The editor itself knows nothing about it; see `CLAUDE.md` at the repo root for how the two are kept apart.

![White's view](exports/whites-view-all.png)

## Files

| File | What it is |
| --- | --- |
| `build.py` | Writes the document and the export jobs. All changes go here. |
| `fog-of-war.json` | The Vellum document, which is generated. The root `vellum.config.json` makes it the editor's starting document. |
| `export-jobs.json` | What `export.html` renders. `build.py` writes it. |
| `exports/` | Rendered SVG and PNG files. `exports/snapshots/` keeps the earlier eight-board version of White's view. |
| `assets/robot-thinking.gif` | The thinking robot, an original drawing. `robot-frames.html` draws its frames. |

## Build, export, redraw the robot

From the repo root, with `python3 tools/devserver.py 8765` running:

```bash
python3 diagrams/fog-of-war/build.py
```

Then open http://127.0.0.1:8765/export.html?jobs=diagrams/fog-of-war/export-jobs.json to re-render `exports/`.

To change the robot, edit `robot-frames.html` and open it at http://127.0.0.1:8765/diagrams/fog-of-war/robot-frames.html. When it finishes, pack the frames and rebuild:

```bash
python3 tools/make_gif.py diagrams/fog-of-war/assets/robot-thinking.gif .tmp/robot/*.png
```

Bump `SAMPLE_VERSION` in `build.py` whenever the document changes, so browsers holding an older autosaved copy pick up the new one.

## The game

The game is `1. e4 Nf6 2. Nc3 d6 3. Bb5 g6 4. Bxe8` (`PLIES` in `build.py`). Fog of War rules apply:

- Each side sees only the squares its pieces could move to, taken as every pseudo-legal destination.
- There is no check.
- A game ends when a king is captured, as White's bishop does on e8.

The embedding values are illustrative, not from a real model. Each one is a hash of what White can see, so two positions that look the same to White get the same vector.

## Page 1: White's view

This page has one column per position. White's view shows five positions: the start, 1. e4, 1… (hidden), 2. Nc3 and 2… (hidden), set by `VIEW_BOARDS`. From top to bottom:

- **Title and move line.** The move line reads "What actually happened: 1. e4 Nf6 2. Nc3 d6".
- **Label 1.** It sits over amber arcs that run from each board to the next.
- **Headings.** Hidden Black moves read "1…" with a grey "Hidden move" tag. There are no question marks.
- **The fogged board.** It uses chess.com colours. Fogged squares are near-black, and the last move is highlighted.
- **Move arrows between boards.**
  - A White move is a solid charcoal arrow. It has the move written on the line and the moved piece, at 80 px, above it.
  - A hidden Black move is a dashed grey arrow with no label.
- **Label 3.** A charcoal line drops from the middle of the 2. Nc3 arrow to label 3, which sits under the boards, between that gap's two teal lines.
- **The embedding.** A teal arrow runs from each board down to its embedding vector: 16 cells between brackets, blue for negative values and orange for positive ones.
- **The context rail.** Each column's line branches right into a shared rail, with rounded corners. The rail merges into every later column's line, so each embedding draws on all earlier states. Label 2 sits just above the rail, between the first two columns.
- **The real position.** Under each vector is a blue-and-black board showing where every piece really stood. It has no title.
- **Under each hidden move:**
  - A grey dashed arrow drops from the middle of the move arrow into a brace. Label 4 sits beside the first of these arrows.
  - Under the brace is a row of Black's possible moves, all the same size, with "…" at each end. The move actually played is green.
  - Below the row is a beam of three small candidate boards. The model's choice is on top, and the candidate matching the real move has a green outline.
  - At the first hidden move the model picks Nf6, which is correct. At the second it picks 2… e5 (`WRONG_CHOICE`), so the correct d6 comes second in the beam.
  - The first beam sits in a cloud-shaped thought bubble, thought by the animated robot to its right.

A separate section, `start-section`, holds the lone starting board as White sees it.

## Page 2: Real positions

All eight positions of the game appear on classic boards with no fog. Yellow squares mark the move just played, and the arrows between the boards carry the moves. This page shows the whole game, even though White's view stops after five positions.

## Colours and labels

| Use | Colour |
| --- | --- |
| Prediction arcs, label 1 | amber `#D97706` |
| Context rail, board-to-vector arrows, label 2 | teal `#0D9488` |
| White's move arrows, label 3 | charcoal `#1E1E1E` |
| Hidden-move arrows, label 4 | grey `#757575` |
| The move actually played | green `#16A34A`, text `#15803D` |
| Real-position boards | blue `#5A8FE8` and near-black `#0E1116` |

| Label | Size | Where |
| --- | --- | --- |
| 1. Next observation prediction | 38 px | Above a thin bracket spanning the first three arcs |
| 2. Aligning representations with underlying state | 32 px | Below the boards and above the rail, first two columns, on two lines |
| 3. Policy and Value function learned through RL self-play | 32 px | Under the boards, hanging by a line from the 2. Nc3 arrow, on two lines |
| 4. Sampling of candidate histories | 44 px | Beside the first grey dashed arrow, centred between the blue boards and its brace |

Each label takes the colour of what it names and sits in space kept free for it. When a label grows, widen the gaps around it; don't let it overlap anything.

## Layout constants in `build.py`

| Constant | Controls |
| --- | --- |
| `VIEW_BOARDS` | How many positions White's view shows |
| `GAP` | Space between boards on White's view |
| `REAL_PAGE_GAP` | Space between boards on the Real positions page, kept apart from `GAP` so that page doesn't move when White's view does |
| `FOG_TOP` | How far down White's boards sit, leaving room for the arcs and label 1 |
| `EMB_GAP`, `RAIL_FRAC` | The drop from a board to its vector, and where the rail runs within it |
| `REAL_GAP` | The drop from a board to its blue real-position board |
| `BRACE_GAP` | The space above the braces, for label 4 |
| `MOVE_ICON` | The size of the piece above White's move arrows |
| `WRONG_CHOICE` | Hidden moves where the model samples the wrong move |
| `LABEL3_MOVE` | The White move that label 3 hangs off |

Both pages come from `sequence_section`, so a shared constant moves both. After a change, the exports of the page you didn't touch should be unchanged.

Stable layer ids:

- **Sections:** `fog-section`, `real-section` and `start-section`.
- **Per position `k`:** `fog-panel-k`, `fog-board-k`, `fog-embedding-k`, `fog-real-k` and `real-panel-k`.

Export jobs refer to these ids. Other ids are numbered in build order and change when the structure does.

## How it got here

The diagram was shaped through annotations on a published copy of Vellum. These decisions were the author's, so keep them unless asked otherwise:

- **Moves.** Show every ply, including Black's, with nothing revealed about hidden moves. Center each piece in its square.
- **Text.** No question marks, and no captions under the diagram. The only text on arrows is the move written on White's arrows.
- **Real positions.** A blue-and-black real-position board sits under each fogged board.
- **Prediction arcs.** They are short, bold and point to point, and amber, not the violet they started as.
- **Embeddings.** Each one looks like a vector. Context reaches it from all earlier states along a three-sided rail with rounded corners, not along tilted arrows, and everything feeding the embeddings is teal.
- **Hidden moves.** Each drops into a brace holding its possible moves, then a beam of three candidate boards. The first beam sits in a thought bubble with a thinking robot.
- **Model's choice.** It is shown against the correct move. The possible moves went back to one size once nothing was being "chosen".
- **Labels.** There are four numbered labels, later enlarged, each with clear space around it.
- **Board count.** White's view was trimmed from eight positions to five. The Real positions page keeps all eight.
