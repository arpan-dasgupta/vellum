"""Build the Fog of War diagram: fog-of-war.json (the Vellum document) and export-jobs.json.

Page 1 "White's view" holds the single starting board and the first moves of the game as
White sees them (VIEW_BOARDS boards). Page 2 "Real positions" shows the whole seven-move
game with the fog lifted. README.md in this folder explains the diagram and its decisions.

Run: python3 diagrams/fog-of-war/build.py
"""
import base64
import hashlib
import json
import math
import os
import re

FILES = 'abcdefgh'
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_VERSION = 17  # bump when the sample changes, so the editor offers the new version
OUT = os.path.join(HERE, 'fog-of-war.json')
JOBS = os.path.join(HERE, 'export-jobs.json')  # what export.html?jobs=diagrams/fog-of-war/export-jobs.json renders

# ---------- chess logic (pseudo-legal moves, no check: Fog of War rules) ----------

def sq(s):
    return FILES.index(s[0]), int(s[1])


def name(f, r):
    return FILES[f] + str(r)


def start_board():
    b = {}
    for i, p in enumerate('RNBQKBNR'):
        b[name(i, 1)] = ('w', p)
        b[name(i, 8)] = ('b', p)
        b[name(i, 2)] = ('w', 'P')
        b[name(i, 7)] = ('b', 'P')
    return b


def visible(board, side, moved):
    """Squares `side` can see: its own squares plus every pseudo-legal destination."""
    vis = set()
    opp = 'b' if side == 'w' else 'w'
    dirs = {'B': [(1, 1), (1, -1), (-1, 1), (-1, -1)], 'R': [(1, 0), (-1, 0), (0, 1), (0, -1)]}
    dirs['Q'] = dirs['B'] + dirs['R']
    ok = lambda f, r: 0 <= f < 8 and 1 <= r <= 8
    for s, (c, p) in board.items():
        if c != side:
            continue
        f, r = sq(s)
        vis.add(s)
        if p in 'BRQ':
            for df, dr in dirs[p]:
                x, y = f + df, r + dr
                while ok(x, y):
                    t = board.get(name(x, y))
                    if t is None:
                        vis.add(name(x, y))
                    else:
                        if t[0] == opp:
                            vis.add(name(x, y))
                        break
                    x += df
                    y += dr
        elif p in 'NK':
            steps = ([(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1), (-1, -2), (-2, -1)] if p == 'N'
                     else [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1) if a or b])
            for df, dr in steps:
                x, y = f + df, r + dr
                if ok(x, y):
                    t = board.get(name(x, y))
                    if t is None or t[0] == opp:
                        vis.add(name(x, y))
            if p == 'K':
                home = 1 if side == 'w' else 8
                if s == name(4, home) and s not in moved:
                    if (name(7, home) not in moved and board.get(name(7, home)) == (side, 'R')
                            and all(name(i, home) not in board for i in (5, 6))):
                        vis.add(name(6, home))
                    if (name(0, home) not in moved and board.get(name(0, home)) == (side, 'R')
                            and all(name(i, home) not in board for i in (1, 2, 3))):
                        vis.add(name(2, home))
        elif p == 'P':
            d = 1 if side == 'w' else -1
            st = 2 if side == 'w' else 7
            if ok(f, r + d) and name(f, r + d) not in board:
                vis.add(name(f, r + d))
                if r == st and name(f, r + 2 * d) not in board:
                    vis.add(name(f, r + 2 * d))
            for df in (-1, 1):
                if ok(f + df, r + d):
                    t = board.get(name(f + df, r + d))
                    if t and t[0] == opp:
                        vis.add(name(f + df, r + d))
    return vis


def pseudo_moves(board, side):
    """Pseudo-legal moves (Fog of War has no check), as (from, to, piece, capture)."""
    out = []
    opp = 'b' if side == 'w' else 'w'
    dirs = {'B': [(1, 1), (1, -1), (-1, 1), (-1, -1)], 'R': [(1, 0), (-1, 0), (0, 1), (0, -1)]}
    dirs['Q'] = dirs['B'] + dirs['R']
    ok = lambda f, r: 0 <= f < 8 and 1 <= r <= 8
    for s_, (c, p) in board.items():
        if c != side:
            continue
        f, r = sq(s_)
        if p in 'BRQ':
            for df, dr in dirs[p]:
                x, y = f + df, r + dr
                while ok(x, y):
                    t = board.get(name(x, y))
                    if t and t[0] == side:
                        break
                    out.append((s_, name(x, y), p, bool(t)))
                    if t:
                        break
                    x += df
                    y += dr
        elif p in 'NK':
            steps = ([(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1), (-1, -2), (-2, -1)] if p == 'N'
                     else [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1) if a or b])
            for df, dr in steps:
                x, y = f + df, r + dr
                if ok(x, y) and (not board.get(name(x, y)) or board[name(x, y)][0] == opp):
                    out.append((s_, name(x, y), p, bool(board.get(name(x, y)))))
        elif p == 'P':
            d = 1 if side == 'w' else -1
            st = 2 if side == 'w' else 7
            if ok(f, r + d) and name(f, r + d) not in board:
                out.append((s_, name(f, r + d), p, False))
                if r == st and name(f, r + 2 * d) not in board:
                    out.append((s_, name(f, r + 2 * d), p, False))
            for df in (-1, 1):
                t = board.get(name(f + df, r + d)) if ok(f + df, r + d) else None
                if t and t[0] == opp:
                    out.append((s_, name(f + df, r + d), p, True))
    return out


def san(move, moves):
    fr, to, p, cap = move
    if p == 'P':
        return (fr[0] + 'x' + to) if cap else to
    rivals = [m for m in moves if m[2] == p and m[1] == to and m[0] != fr]
    return p + (fr[0] if rivals else '') + ('x' if cap else '') + to


PLIES = [('e2', 'e4', '1. e4'), ('g8', 'f6', '1… Nf6'), ('b1', 'c3', '2. Nc3'), ('d7', 'd6', '2… d6'),
         ('f1', 'b5', '3. Bb5'), ('g7', 'g6', '3… g6'), ('b5', 'e8', '4. Bxe8')]


def positions():
    b = start_board()
    moved = set()
    out = [{'board': dict(b), 'vis': visible(b, 'w', moved), 'last': None, 'side': None}]
    for i, (fr, to, _) in enumerate(PLIES):
        b[to] = b.pop(fr)
        moved |= {fr, to}
        out.append({'board': dict(b), 'vis': visible(b, 'w', moved), 'last': [fr, to],
                    'side': 'w' if i % 2 == 0 else 'b'})
    return out

# ---------- vector chess pieces (100 x 100 artboard, original drawings) ----------

BASE = 'M24,78 H76 Q79,78 79,81 V87 Q79,90 76,90 H24 Q21,90 21,87 V81 Q21,78 24,78 Z'


def circle(cx, cy, r):
    return f'M{cx - r},{cy} A{r},{r} 0 1 0 {cx + r},{cy} A{r},{r} 0 1 0 {cx - r},{cy} Z'


PIECES = {
    'P': {'shift': -3, 'paths': [
        ('body', BASE),
        ('body', 'M41,44 C41,58 34,66 29,78 H71 C66,66 59,58 59,44 Z'),
        ('body', 'M39,38 H61 L63,44 H37 Z'),
        ('body', circle(50, 27, 11)),
    ]},
    'R': {'shift': -2, 'paths': [
        ('body', BASE),
        ('body', 'M28,70 H72 V78 H28 Z'),
        ('body', 'M34,38 H66 L68,70 H32 Z'),
        ('body', 'M30,32 H70 L67,38 H33 Z'),
        ('body', 'M26,14 H36 V21 H44 V14 H56 V21 H64 V14 H74 V32 H26 Z'),
    ]},
    'N': {'shift': 0, 'paths': [
        ('body', BASE),
        ('body', 'M70,78 C73,60 71,42 63,30 C59,24 54,20 48,18 L46,10 L41,18 C36,20 31,24 29,30 L21,48 '
                 'C19,53 21,58 26,58 C30,58 32,56 34,54 L42,48 C45,46 48,44 50,42 C49,52 42,60 36,66 '
                 'C32,70 31,74 31,78 Z'),
        ('ink', 'M63,32 C67,42 69,56 67,72'),
        ('dot', circle(38.5, 29, 2.8)),
        ('dot', circle(25.5, 50.5, 1.8)),
    ]},
    'B': {'shift': 2, 'paths': [
        ('body', BASE),
        ('body', 'M40,59 H60 C62,66 67,72 70,78 H30 C33,72 38,66 40,59 Z'),
        ('body', 'M38,53 H62 V59 H38 Z'),
        ('body', 'M50,16 C38,26 33,38 37,47 C39,51 44,53 50,53 C56,53 61,51 63,47 C67,38 62,26 50,16 Z'),
        ('body', circle(50, 11, 5)),
        ('ink', 'M55,27 L46,40'),
    ]},
    'Q': {'shift': -1, 'paths': [
        ('body', BASE),
        ('body', 'M29,70 H71 V78 H29 Z'),
        ('body', 'M31,70 L22,34 L35,50 L36,25 L45,47 L50,21 L55,47 L64,25 L65,50 L78,34 L69,70 Z'),
        ('body', circle(22, 30, 4.5)), ('body', circle(36, 21, 4.5)), ('body', circle(50, 17, 4.5)),
        ('body', circle(64, 21, 4.5)), ('body', circle(78, 30, 4.5)),
    ]},
    'K': {'shift': 2, 'paths': [
        ('body', BASE),
        ('body', 'M29,70 H71 V78 H29 Z'),
        ('body', 'M30,44 Q50,30 70,44 L66,70 H34 Z'),
        ('body', 'M44,28 H56 V37 H44 Z'),
        ('body', 'M46,6 H54 V12 H60 V20 H54 V28 H46 V20 H40 V12 H46 Z'),
    ]},
}
PIECE_NAMES = {'K': 'King', 'Q': 'Queen', 'R': 'Rook', 'B': 'Bishop', 'N': 'Knight', 'P': 'Pawn'}

# ---------- node builders ----------

LIGHT, DARK = '#EEEED2', '#769656'
HL_L, HL_D = '#F5F682', '#B9CA43'
CHAR, WHITE, GREY, BLK = '#1E1E1E', '#FFFFFF', '#757575', '#312E2B'
FOG = '#262626'

# Board themes. CLASSIC mirrors chess.com green; BLUE is the blue-and-black board used for real positions.
CLASSIC = {'light': LIGHT, 'dark': DARK, 'hl_light': HL_L, 'hl_dark': HL_D, 'label_on_light': DARK, 'label_on_dark': LIGHT,
           'white': {'fill': WHITE, 'stroke': CHAR, 'detail': CHAR},
           'black': {'fill': BLK, 'stroke': '#101010', 'detail': '#E9E9E9'}}
BLUE = {'light': '#5A8FE8', 'dark': '#0E1116', 'hl_light': '#A9C8FF', 'hl_dark': '#23406E',
        'label_on_light': '#0E1116', 'label_on_dark': '#8AB4FF',
        'white': {'fill': WHITE, 'stroke': '#0E1116', 'detail': '#0E1116'},
        'black': {'fill': '#0B0E13', 'stroke': '#8AB4FF', 'detail': '#8AB4FF'}}
SECTION_FILL, SECTION_STROKE = '#F9F9F9', '#D9D9D9'
_ids = [0]


def nid(prefix='n'):
    _ids[0] += 1
    return f'{prefix}{_ids[0]}'


def rect(nm, x, y, w, h, fill, **kw):
    return {'id': kw.pop('id', None) or nid(), 'type': 'RECT', 'name': nm, 'x': x, 'y': y, 'w': w, 'h': h,
            'fill': fill, **kw}


def text(nm, x, y, content, size, weight=500, color=CHAR, **kw):
    n = {'id': nid(), 'type': 'TEXT', 'name': nm, 'x': x, 'y': y, 'text': content, 'fontSize': size,
         'fontWeight': weight, 'color': color, 'autoWidth': True, 'lineHeight': 1.21}
    n.update(kw)
    if 'w' in kw:
        n['autoWidth'] = False
    return n


def group(nm, children, **kw):
    return {'id': kw.pop('id', None) or nid('g'), 'type': 'GROUP', 'name': nm, 'children': children, **kw}


def section(nm, x, y, w, h, children, **kw):
    return {'id': kw.pop('id', None) or nid('s'), 'type': 'SECTION', 'name': nm, 'x': x, 'y': y, 'w': w, 'h': h,
            'fill': SECTION_FILL, 'stroke': SECTION_STROKE, 'strokeWidth': 1, 'radius': 12, 'children': children, **kw}


def piece(side, kind, sqname, x, y, size, theme=CLASSIC):
    spec = PIECES[kind]
    white = side == 'w'
    col = theme['white' if white else 'black']
    return {'id': nid('pc'), 'type': 'PATH', 'name': f"{'White' if white else 'Black'} {PIECE_NAMES[kind].lower()} {sqname}",
            'x': x, 'y': y + spec['shift'] * size / 100, 'w': size, 'h': size, 'vw': 100, 'vh': 100,
            'fill': col['fill'], 'stroke': col['stroke'], 'detail': col['detail'], 'strokeWidth': 3.2,
            'paths': [{'role': r, 'd': d} for r, d in spec['paths']]}


def board_nodes(ox, oy, S, pos, fog, board_id, whole_fog_rect=False, theme=CLASSIC, coords=True):
    """Board backing, squares, coordinates, pieces and (optionally) fog for one position."""
    board, vis = pos['board'], pos['vis']
    # In White's view only White's own last move is highlighted; Black's move stays secret.
    last = set(pos['last'] or []) if not (fog and pos['side'] == 'b') else set()
    squares, labels, pieces, fogs = [], [], [], []
    backing = rect(f'Board', ox, oy, 8 * S, 8 * S, theme['dark'], id=board_id)
    for r in range(8, 0, -1):
        for f in range(8):
            nm = name(f, r)
            dark = (f + r) % 2 == 1
            x, y = ox + f * S, oy + (8 - r) * S
            if nm in last:
                col = theme['hl_dark'] if dark else theme['hl_light']
            else:
                col = theme['dark'] if dark else theme['light']
            squares.append(rect(nm, x, y, S, S, col))
            lab_col = theme['label_on_dark'] if dark else theme['label_on_light']
            fs = 11 if S < 70 else 14
            if coords and f == 0:
                labels.append(text(f'Rank {r}', x + 3, y + 2, str(r), fs, 500, lab_col))
            if coords and r == 1:
                labels.append(text(f'File {FILES[f]}', x + S - 23, y + S - fs * 1.21 - 2, FILES[f], fs, 500, lab_col,
                                   w=20, align='right'))
            if fog and not whole_fog_rect and nm not in vis:
                fogs.append(rect(f'Fog {nm}', x, y, S, S, FOG, fillOpacity=0.82))
            occ = board.get(nm)
            if occ and (not fog or occ[0] == 'w' or nm in vis):
                pieces.append(piece(occ[0], occ[1], nm, x, y, S, theme))
    kids = [backing,
            group('Squares', squares),
            group('Coordinates', labels),
            group('Pieces', pieces)]
    if fog and whole_fog_rect:
        kids.append(rect('Fog (ranks 5–8)', ox, oy, 8 * S, 4 * S, FOG, fillOpacity=0.82))
    elif fogs:
        kids.append(group('Fog', fogs))
    return kids


def caption(x, y, w, main, aside=None, size=16):
    n = text('Caption', x, y, main, size, 500, CHAR, w=w, lineHeight=1.3)
    if aside:
        n['runs'] = [{'text': main + '\n', 'color': CHAR}, {'text': aside, 'color': GREY}]
        n['text'] = main + '\n' + aside
    return n


def arrow(from_id, to_id, label, hidden, gap=0, width=3, show_label=False):
    a = {'id': nid('c'), 'type': 'CONNECTOR', 'name': ('Hidden Black move ' if hidden else 'Move ') + label,
         'from': {'id': from_id, 'side': 'RIGHT'}, 'to': {'id': to_id, 'side': 'LEFT'},
         'stroke': GREY if hidden else CHAR, 'strokeWidth': width, 'gap': gap,
         'dash': '12 7' if hidden else None, 'arrow': True}
    if show_label:
        # The move sits on the line, on a patch of the section's own colour.
        a.update(label=label, labelSize=14, labelFill=SECTION_FILL)
    return a


PREDICT = '#D97706'  # amber, for the next-state prediction arcs
CONTEXT = '#0D9488'  # teal, for the context rail carrying earlier states into each embedding


def prediction_arc(from_id, to_id, k):
    """A curved arrow over the top of two boards: this fogged state predicts the next one."""
    return {'id': nid('c'), 'type': 'CONNECTOR', 'name': f'Predicts state {k + 1} from state {k}',
            'from': {'id': from_id, 'side': 'TOP', 'at': 0.82}, 'to': {'id': to_id, 'side': 'TOP', 'at': 0.19},
            'bend': 80, 'gap': [8, 8], 'stroke': PREDICT, 'strokeWidth': 6, 'headSize': 22, 'arrow': True}


# ---------- embedding vectors ----------

EMB_DIM = 16
EMB_NEG, EMB_POS = (0x2F, 0x6F, 0xEB), (0xF5, 0x9E, 0x0B)  # blue for negative values, orange for positive


def embedding(pos):
    """A stand-in embedding of White's fogged view: deterministic from what White can see, so two
    positions that look the same to White get the same vector."""
    seen = ' '.join(sorted(pos['vis'])) + '|' + ' '.join(
        sorted(f"{c}{p}{sq}" for sq, (c, p) in pos['board'].items() if c == 'w' or sq in pos['vis']))
    digest = hashlib.sha256(seen.encode()).digest()
    return [round(b / 127.5 - 1, 3) for b in digest[:EMB_DIM]]


def emb_color(v):
    target = EMB_POS if v >= 0 else EMB_NEG
    t = min(1.0, abs(v)) * 0.9 + 0.1
    r, g, b = (round(255 + (c - 255) * t) for c in target)
    return f'#{r:02X}{g:02X}{b:02X}'


def vector_nodes(ox, y, values, gid):
    """A row of cells between square brackets, like a vector written out."""
    cw, gap, ch = 24, 3, 36
    row_w = EMB_DIM * cw + (EMB_DIM - 1) * gap
    x0 = ox + (BW - row_w) / 2
    cells = [rect(f'Value {i + 1}: {v:+.2f}', x0 + i * (cw + gap), y, cw, ch, emb_color(v), radius=3)
             for i, v in enumerate(values)]
    def bracket(nm, x, flip):
        d = 'M9,1 H1 V47 H9' if not flip else 'M1,1 H9 V47 H1'
        return {'id': nid('pc'), 'type': 'PATH', 'name': nm, 'x': x, 'y': y - 6, 'w': 10, 'h': 48, 'vw': 10, 'vh': 48,
                'fill': None, 'stroke': CHAR, 'detail': CHAR, 'strokeWidth': 2.5, 'paths': [{'role': 'ink', 'd': d}]}
    return group('Embedding', [bracket('Left bracket', x0 - 16, False), group('Values', cells),
                               bracket('Right bracket', x0 + row_w + 6, True)], id=gid)

# ---------- content ----------

FOG_TEXT = [
    ('Start', 'White sees only the squares its pieces could move to: ranks 1–4. All of Black is hidden.', None),
    ('1. e4', 'The pawn advance opens lines for the queen and bishop. White can now see out to a6, e5 and h5.', None),
    ('1…', 'Black moved, but nothing White can see has changed. White has no idea what was played.',
     'Actually played: 1…Nf6, attacking the e4 pawn.'),
    ('2. Nc3', 'White can’t see any threat to e4, but defends it anyway. In the fog you guard against attacks you can’t see.', None),
    ('2…', 'Another invisible move. The board looks exactly the same.',
     'Actually played: 2…d6, which quietly opens the diagonal from b5 to Black’s king.'),
    ('3. Bb5', 'The bishop probes the a4–e8 diagonal and finds it open: Black’s king appears on e8. In normal chess this is check, but Fog of War gives no warning.', None),
    ('3…', 'Black moved again, and the king is still on e8. Whatever Black played, it didn’t deal with the bishop.',
     'Actually played: 3…g6. No Black piece can move to b5, so Black never saw the bishop.'),
    ('4. Bxe8, White wins', 'White captures the king and wins. Fog of War has no checkmate: taking the king ends the game.', None),
]

REAL_TEXT = [
    ('Start', 'Both armies on their starting squares.'),
    ('1. e4', 'White’s king pawn takes the centre.'),
    ('1… Nf6', 'The knight attacks e4. None of White’s pieces can see f6, so White never learns of it.'),
    ('2. Nc3', 'White defends e4 without knowing it was attacked.'),
    ('2… d6', 'The d-pawn’s step clears d7 and opens the b5–e8 diagonal to Black’s king.'),
    ('3. Bb5', 'The bishop attacks the king on e8. In normal chess this would be check.'),
    ('3… g6', 'Black prepares …Bg7, unaware of the bishop on b5.'),
    ('4. Bxe8', 'The king is captured and the game ends, with 15 Black pieces still on the board.'),
]

S, BW, PAD, GAP, TOP = 56, 448, 48, 260, 210
REAL_PAGE_GAP = 220  # board spacing on the Real positions page (White's view uses GAP, widened for the labels)
FOG_TOP = 360    # the fogged row sits lower, leaving room for the prediction arcs and their label
EMB_GAP = 250    # from the bottom of a fogged board to its embedding vector (room for the rail and its label)
REAL_GAP = EMB_GAP + 36 + 44  # from the bottom of a fogged board to the blue real-position board below it
RAIL_FRAC = 0.62  # the context rail's height within the gap between boards and vectors
MOVE_GAP = 20    # space between a move arrow and the boards it joins
MOVE_ICON = 80   # size of the moved piece drawn above a White move arrow
BRACE_W, BRACE_H = 460, 40   # the brace under each hidden move, where its possible moves will go
BRACE_GAP = 130              # from the bottom of the real-position boards to the braces (room for label 4)
POSSIBLE_SPACE = 18 + 72 + 4 + 22 + 64 + (3 * 176 + 2 * 14 + 2 * 10) + 40 + 60  # moves, then the beam and its bubble
MOVE_PIECE = {'1. e4': 'P', '2. Nc3': 'N', '3. Bb5': 'B', '4. Bxe8': 'B'}  # the White piece that moved
HEAD_W = {'1…': 33.1, '2…': 37.9, '3…': 37.7}  # measured Inter Semi Bold 24px widths
REAL_LABELS = ['Real position: start', 'Real position after 1. e4', 'Real position after 1… Nf6',
               'Real position after 2. Nc3', 'Real position after 2… d6', 'Real position after 3. Bb5',
               'Real position after 3… g6', 'Real position after 4. Bxe8']
SEQ_X, SEQ_Y = 1000, 200


VIEW_BOARDS = 5  # boards shown in White's view: start, 1. e4, 1…, 2. Nc3, 2…  (two hidden moves)


def sequence_section(title, intro, move_line, texts, fogged, prefix, boards=8):
    pos = positions()[:boards]
    n = len(pos)
    gap = GAP if fogged else REAL_PAGE_GAP  # the Real positions page keeps its own, tighter spacing
    kids = [
        text('Title', SEQ_X + PAD, SEQ_Y + 40, title, 40, 600),
        text('Intro', SEQ_X + PAD, SEQ_Y + 98, intro, 16, 500, GREY, w=n * BW + (n - 1) * gap),
    ]
    lead = 'What actually happened:'
    ml = text('Move list', SEQ_X + PAD, SEQ_Y + 138, move_line, 24, 600)
    if fogged:
        ml['runs'] = [{'text': lead, 'color': GREY}, {'text': move_line[len(lead):], 'color': CHAR}]
    kids.append(ml)
    board_ids = []
    top = FOG_TOP if fogged else TOP
    for k, p in enumerate(pos):
        ox, oy = SEQ_X + PAD + k * (BW + gap), SEQ_Y + top
        by = oy + 44
        head_txt = texts[k][0]
        hidden = fogged and p['side'] == 'b'
        if hidden:
            hw = HEAD_W.get(head_txt, 40)
            hx = ox + (BW - (hw + 12 + 100)) / 2
            pk = [text('Heading', hx, oy, head_txt, 24, 600)]
            tx = hx + hw + 12
            pk.append(rect('Hidden move tag', tx, oy + 2.5, 100, 24, GREY, radius=12))
            pk.append(text('Hidden move', tx, oy + 2.5 + (24 - 13 * 1.3) / 2, 'Hidden move', 13, 600, WHITE,
                           w=100, align='center', lineHeight=1.3))
        else:
            pk = [text('Heading', ox, oy, head_txt, 24, 600, w=BW, align='center')]
        bid = f'{prefix}-board-{k}'
        board_ids.append(bid)
        pk += board_nodes(ox, by, S, p, fogged, bid)
        if fogged:
            # The real position, fog lifted, in the blue-and-black theme.
            vid = f'{prefix}-embedding-{k}'
            pk.append(vector_nodes(ox, by + BW + EMB_GAP, embedding(p), vid))
            pk.append({'id': nid('c'), 'type': 'CONNECTOR', 'name': 'Board to embedding',
                       'from': {'id': bid, 'side': 'BOTTOM'}, 'to': {'id': vid, 'side': 'TOP'},
                       'gap': [10, 10], 'stroke': CONTEXT, 'strokeWidth': 4, 'arrow': True})
            ry = by + BW + REAL_GAP
            pk.append(group('Real position', board_nodes(ox, ry, S, p, False, f'{prefix}-real-board-{k}', theme=BLUE),
                            id=f'{prefix}-real-{k}'))
        kids.append(group(f'Position {k} · {head_txt}', pk, id=f'{prefix}-panel-{k}'))
    labels = ([t[0] for t in FOG_TEXT[1:]] if fogged else [t[0] for t in REAL_TEXT[1:]])
    if fogged:
        labels = ['1. e4', '1…', '2. Nc3', '2…', '3. Bb5', '3…', '4. Bxe8']
    for k in range(n - 1):
        if not fogged:
            kids.append(arrow(board_ids[k], board_ids[k + 1], labels[k], False))
            continue
        hidden = k % 2 == 1
        a = arrow(board_ids[k], board_ids[k + 1], labels[k], hidden, gap=MOVE_GAP, width=5, show_label=not hidden)
        if hidden:
            # An unknown move drops down into a brace that will hold its possible moves.
            gcx = SEQ_X + PAD + k * (BW + gap) + BW + gap / 2
            by_ = SEQ_Y + top + 44 + BW + REAL_GAP + BW + BRACE_GAP
            br = brace(f'Possible moves for {labels[k]}', gcx - BRACE_W / 2, by_)
            down = {'id': nid('c'), 'type': 'CONNECTOR', 'name': 'Into possible moves',
                    'from': {'id': a['id'], 'side': 'CENTER'}, 'to': {'id': br['id'], 'side': 'TOP'},
                    'gap': [8, 6], 'stroke': GREY, 'strokeWidth': 3, 'dash': '12 7', 'headSize': 16, 'arrow': True}
            row_y = by_ + BRACE_H + 18
            row, pickd, real, shown, moves = possible_moves_row(pos[k], PLIES[k][:2], gcx, row_y, WRONG_CHOICE.get(k))
            tb_y = row_y + 72 + 4 + 22 + THOUGHT_GAP
            # A beam of three candidate histories: the model's choice on top, then two more. The one
            # matching the move actually played is outlined in green.
            if pickd is real:
                cands = [pickd, shown[1], shown[3]]
            else:
                cands = [pickd, real] + [m for m in shown if m is not pickd and m is not real][:1]
            beam = beam_stack(cands, real, pos[k], moves, gcx, tb_y, f'{prefix}-beam-{k}')
            parts = [a, down, br, row]
            if k == 1:
                # The first beam sits in a thought bubble, thought by a robot on its right.
                parts.append(thinking(gcx - BEAM_W / 2 - BEAM_PAD, tb_y - BEAM_PAD, BEAM_W + 2 * BEAM_PAD, BEAM_H, beam))
                # Label 4, beside the grey arrow and just above the brace.
                parts.append(text('Label 4', gcx + 16, by_ - 74, '4. Sampling of candidate histories', 32, 600, GREY))
            else:
                parts.append(beam)
            kids.append(group(f'Hidden move {labels[k]}', parts))
            continue
        # White moves carry the moving piece above the arrow.
        mid_x = SEQ_X + PAD + k * (BW + gap) + BW + gap / 2
        mid_y = SEQ_Y + top + 44 + BW / 2
        size = MOVE_ICON
        pc = piece('w', MOVE_PIECE[labels[k]], labels[k], mid_x - size / 2, mid_y - 16 - size, size)
        pc['name'] = f'Moved piece ({labels[k]})'
        kids.append(group(f'Move {labels[k]}', [a, pc]))
    if fogged:
        kids.append(group('Next-state predictions', [prediction_arc(board_ids[k], board_ids[k + 1], k) for k in range(n - 1)]))
        kids.append(section_labels(top))
        # Context rail: each column's board-to-embedding line branches right into a shared rail,
        # and the rail merges down into every later column's line, so the embedding at i draws on
        # all the states before it. Straight runs with rounded corners.
        kids.append(context_rail(SEQ_X + PAD, SEQ_Y + top + 44 + BW, n))
    w = PAD * 2 + n * BW + (n - 1) * gap
    h = (top + 44 + BW + REAL_GAP + BW + BRACE_GAP + BRACE_H + POSSIBLE_SPACE) if fogged else (top + 44 + BW + PAD)
    return section(f'Fog of War — {n - 1}-move sequence' if fogged else 'Real positions', SEQ_X, SEQ_Y, w, h, kids,
                   id=f'{prefix}-section')


def brace(name, x, y):
    """A horizontal curly brace opening downward: tip up at the centre, ends curling down."""
    w, h, t, r = BRACE_W, BRACE_H, 16, 22
    m = w / 2
    d = (f'M0,{h} Q0,{t} {r},{t} H{m - r} Q{m},{t} {m},0 Q{m},{t} {m + r},{t} H{w - r} Q{w},{t} {w},{h}')
    return {'id': nid('pc'), 'type': 'PATH', 'name': name, 'x': x, 'y': y, 'w': w, 'h': h, 'vw': w, 'vh': h,
            'fill': None, 'stroke': GREY, 'detail': GREY, 'strokeWidth': 3, 'paths': [{'role': 'ink', 'd': d}]}


CORRECT = {'white': {'fill': WHITE, 'stroke': CHAR, 'detail': CHAR},
           'black': {'fill': '#16A34A', 'stroke': '#14532D', 'detail': '#DCFCE7'}}  # the move actually played
CORRECT_TEXT = '#15803D'
# Hidden moves where the model samples the wrong move: ply index -> (from, to) of its choice.
WRONG_CHOICE = {3: ('e7', 'e5')}


def apply_move(before, mv):
    b = dict(before['board'])
    b[mv[1]] = b.pop(mv[0])
    return {'board': b, 'vis': set(), 'last': [mv[0], mv[1]], 'side': 'b'}


def possible_moves_row(before, played, cx, y, chosen=None):
    """A few of Black's possible moves with their pieces and an ellipsis at each end for the rest.
    The move the model chose is in the middle and bigger; the move actually played is green.
    Returns the row and the chosen move."""
    moves = sorted(pseudo_moves(before['board'], 'b'), key=lambda m: ('KQRBNP'.index(m[2]), m[0], m[1]))
    real = next(m for m in moves if (m[0], m[1]) == tuple(played))
    pickd = next(m for m in moves if (m[0], m[1]) == tuple(chosen)) if chosen else real
    others = [m for m in moves if m is not real and m is not pickd]
    pick = [others[round(i * (len(others) - 1) / 3)] for i in range(4)]  # spread across the list
    shown = pick[:2] + [real] + pick[2:] if pickd is real else pick[:2] + [pickd, real] + pick[2:3]
    slot, size, row_h = 76, 50, 72  # every move the same size; nothing is singled out as chosen
    total = len(shown) * slot
    x0 = cx - total / 2
    nodes = [text('More moves', x0 - 30, y + 8, '…', 28, 600, GREY),
             text('More moves', x0 + total + 6, y + 8, '…', 28, 600, GREY)]
    for i, m in enumerate(shown):
        is_real = m is real
        mx = x0 + i * slot + slot / 2
        pc = piece('b', m[2], m[1], mx - size / 2, y + (row_h - size) / 2, size, CORRECT if is_real else CLASSIC)
        pc['name'] = ('Correct: ' if is_real else 'Possible: ') + san(m, moves)
        lab = text('Move', mx - slot / 2, y + row_h + 4, san(m, moves), 14, 700 if is_real else 500,
                   CORRECT_TEXT if is_real else GREY, w=slot, align='center')
        nodes += [pc, lab]
    return group(f'Possible moves ({len(moves)} in all)', nodes), pickd, real, shown, moves


THOUGHT_S = 34   # square size of a single "thought out" board
THOUGHT_GAP = 64  # from the played move's label down to the beam
BEAM_S, BEAM_GAP, BEAM_PAD = 22, 14, 10  # the beam of three candidate boards
BEAM_W = 8 * BEAM_S
BEAM_H = 3 * BEAM_W + 2 * BEAM_GAP + 2 * BEAM_PAD
BUBBLE_PAD, BUBBLE_BUMP = 24, 14  # the thought bubble around the first thought-out board
ROBOT = 120        # size of the robot head thinking about it
ROBOT_GIF = os.path.join(HERE, 'assets', 'robot-thinking.gif')  # drawn by robot-frames.html


def thought_board(after, cx, y, bid):
    """The full, unfogged position once the played move is made: what the model imagines after
    sampling it. Drawn small, in the real-position theme, right under the played move."""
    return group('Thought-out position', board_nodes(cx - 4 * THOUGHT_S, y, THOUGHT_S, after, False, bid, theme=BLUE),
                 id=bid + '-group')


def cloud_path(w, h, r, step, bump):
    """A thought-bubble outline around a w x h rounded rectangle, as path data in local coordinates
    (the rectangle starts at bump, bump). Scallops bulge outward along the whole edge."""
    ox, oy = bump, bump
    segs = [('line', (ox + r, oy), (ox + w - r, oy)), ('arc', (ox + w - r, oy + r), -90, 0),
            ('line', (ox + w, oy + r), (ox + w, oy + h - r)), ('arc', (ox + w - r, oy + h - r), 0, 90),
            ('line', (ox + w - r, oy + h), (ox + r, oy + h)), ('arc', (ox + r, oy + h - r), 90, 180),
            ('line', (ox, oy + h - r), (ox, oy + r)), ('arc', (ox + r, oy + r), 180, 270)]
    lens = [math.dist(a, b) if kind == 'line' else r * math.radians(abs(e - s0)) for kind, *rest in segs
            for a, b, s0, e in [(rest[0], rest[1], 0, 0) if kind == 'line' else ((0, 0), (0, 0), rest[1], rest[2])]]
    total = sum(lens)
    n = max(8, round(total / step))

    def at(dist):
        for i, ((kind, *rest), ln) in enumerate(zip(segs, lens)):
            if dist <= ln or i == len(segs) - 1:
                t = dist / ln if ln else 0
                if kind == 'line':
                    (x1, y1), (x2, y2) = rest
                    return x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
                (cx, cy), a0, a1 = rest
                ang = math.radians(a0 + (a1 - a0) * t)
                return cx + r * math.cos(ang), cy + r * math.sin(ang)
            dist -= ln
        return segs[0][1]
    pts = [at(total * i / n) for i in range(n)]
    d = f'M{pts[0][0]:.1f},{pts[0][1]:.1f}'
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        ln = math.hypot(dx, dy) or 1
        mx, my = (x1 + x2) / 2 + dy / ln * bump * 2, (y1 + y2) / 2 - dx / ln * bump * 2
        d += f' Q{mx:.1f},{my:.1f} {x2:.1f},{y2:.1f}'
    return d + ' Z'


def beam_stack(cands, real, before, moves, cx, y, bid):
    """Three small boards stacked on a light band, one per candidate move."""
    nodes = [rect('Beam', cx - BEAM_W / 2 - BEAM_PAD, y - BEAM_PAD, BEAM_W + 2 * BEAM_PAD, BEAM_H, '#E9EEF5', radius=14)]
    for i, mv in enumerate(cands):
        by = y + i * (BEAM_W + BEAM_GAP)
        board = board_nodes(cx - BEAM_W / 2, by, BEAM_S, apply_move(before, mv), False, f'{bid}-{i}', theme=BLUE, coords=False)
        nodes.append(group(f'Candidate {i + 1}: {san(mv, moves)}', board))
        if mv is real:
            nodes.append(rect('Correct candidate', cx - BEAM_W / 2 - 3, by - 3, BEAM_W + 6, BEAM_W + 6, None,
                              stroke='#16A34A', strokeWidth=3, radius=3))
    return group('Beam of candidate histories', nodes, id=bid)


def thinking(bx, by, cw, ch, content):
    """Wrap content in a thought bubble whose trail of dots leads right to an animated robot head."""
    w, h = cw + 2 * BUBBLE_PAD, ch + 2 * BUBBLE_PAD
    x, y = bx - BUBBLE_PAD - BUBBLE_BUMP, by - BUBBLE_PAD - BUBBLE_BUMP
    tw, th = w + 2 * BUBBLE_BUMP, h + 2 * BUBBLE_BUMP
    bubble = {'id': nid('pc'), 'type': 'PATH', 'name': 'Thought bubble', 'x': x, 'y': y, 'w': tw, 'h': th,
              'vw': tw, 'vh': th, 'fill': WHITE, 'stroke': '#9CA3AF', 'detail': '#9CA3AF', 'strokeWidth': 2.5,
              'paths': [{'role': 'body', 'd': cloud_path(w, h, 60, 46, BUBBLE_BUMP)}]}
    right = x + tw
    cy = by + ch * 0.45
    dots = []
    for i, (dx, r) in enumerate([(16, 12), (44, 9), (66, 6)]):
        dots.append({'id': nid(), 'type': 'ELLIPSE', 'name': f'Thought trail {i + 1}', 'x': right + dx - r,
                     'y': cy + i * 10 - r, 'w': 2 * r, 'h': 2 * r, 'fill': WHITE, 'stroke': '#9CA3AF', 'strokeWidth': 2.5})
    with open(ROBOT_GIF, 'rb') as fh:
        src = 'data:image/gif;base64,' + base64.b64encode(fh.read()).decode()
    robot = {'id': nid(), 'type': 'IMAGE', 'name': 'Robot thinking (animated GIF)', 'x': right + 76,
             'y': cy + 20 - ROBOT * 0.55, 'w': ROBOT, 'h': ROBOT, 'src': src}
    return group('Thinking robot', [bubble, content] + dots + [robot])


def section_labels(top):
    """Labels 1 to 3, each in the colour of what it names, placed in space kept free for them."""
    col = lambda k: SEQ_X + PAD + k * (BW + GAP)
    board_top = SEQ_Y + top + 44
    nodes = []
    # 1. Over the first three prediction arcs, with a bracket showing the span.
    x1, x2 = col(0) + 0.82 * BW, col(3) + 0.19 * BW
    by = board_top - 80 - 24
    d = f'M0,10 V0 H{x2 - x1:.1f} V10'
    nodes.append({'id': nid('pc'), 'type': 'PATH', 'name': 'Label 1 span', 'x': x1, 'y': by, 'w': x2 - x1, 'h': 10,
                  'vw': x2 - x1, 'vh': 10, 'fill': None, 'stroke': PREDICT, 'detail': PREDICT, 'strokeWidth': 2,
                  'paths': [{'role': 'ink', 'd': d}]})
    nodes.append(text('Label 1', x1, by - 58, '1. Next observation prediction', 38, 600, PREDICT, w=x2 - x1, align='center'))
    # 2. Just under the boards and above the context rail, between the first two columns' teal lines.
    c0, c1 = col(0) + BW / 2, col(1) + BW / 2
    nodes.append(text('Label 2', c0 + 40, board_top + BW + 26, '2. Aligning representations with underlying state', 32, 600,
                      CONTEXT, w=c1 - c0 - 80, align='center'))
    # 3. Under the 2. Nc3 move arrow, wrapped to the gap between the boards with a margin each side.
    gx = col(2) + BW
    nodes.append(text('Label 3', gx + 20, board_top + BW / 2 + 30, '3. Policy and Value function learned through RL self-play',
                      26, 600, CHAR, w=GAP - 40, align='center', lineHeight=1.25))
    return group('Labels', nodes)


def context_rail(x0, board_bottom, n):
    rail_y = board_bottom + EMB_GAP * RAIL_FRAC
    r = 20
    cx = [x0 + k * (BW + GAP) + BW / 2 for k in range(n)]
    left, top = cx[0], rail_y - r
    d = ''
    for k in range(n - 1):
        a, b = cx[k] - left, cx[k + 1] - left
        # Leave column k's line, run right, and merge down into column k+1's line.
        d += (f'M{a:.1f},0 Q{a:.1f},{r} {a + r:.1f},{r} H{b - r:.1f} Q{b:.1f},{r} {b:.1f},{2 * r} ')
    w, h = cx[-1] - left, 2 * r
    return {'id': nid('pc'), 'type': 'PATH', 'name': 'Context rail (each embedding draws on all earlier states)',
            'x': left, 'y': top, 'w': w, 'h': h, 'vw': w, 'vh': h, 'fill': None, 'stroke': CONTEXT, 'detail': CONTEXT,
            'strokeWidth': 3, 'paths': [{'role': 'ink', 'd': d.strip()}]}


def start_section():
    p0 = positions()[0]
    S0, bx, by = 80, 240, 310
    kids = [text('Title', 240, 232, 'Fog of War — Starting position (White to move)', 24, 600)]
    kids += board_nodes(bx, by, S0, p0, True, 'start-board', whole_fog_rect=True)
    ry = by + 8 * S0 + 40
    kids.append(group('Real position', board_nodes(bx, ry, S0, p0, False, 'start-real-board', theme=BLUE),
                      id='start-real'))
    h = ry + 8 * S0 + 40 - 200
    return section('Fog of War — Start', 200, 200, 720, h, kids, id='start-section')


def main():
    fog_page = {'id': 'page-view', 'name': 'White’s view', 'children': [
        start_section(),
        sequence_section('Fog of War: four moves through White’s eyes',
                         'Each board is exactly what White sees after every move, White’s and Black’s. Fogged squares '
                         'are ones no White piece could move to. When Black moves, White learns nothing unless something '
                         'in view changes. Under each board, in blue, is where every piece really stood.',
                         'What actually happened:   1. e4 Nf6    2. Nc3 d6',
                         FOG_TEXT, True, 'fog', boards=VIEW_BOARDS),
    ]}
    real_page = {'id': 'page-real', 'name': 'Real positions', 'children': [
        sequence_section('Fog of War: the real game, no fog',
                         'The same seven moves with the fog lifted, showing where every piece actually stood. '
                         'The yellow squares mark the move just played, by either side.',
                         '1. e4 Nf6    2. Nc3 d6    3. Bb5 g6    4. Bxe8',
                         REAL_TEXT, False, 'real'),
    ]}
    doc = {'version': 1, 'name': 'Fog of War', 'sample': 'fog-of-war', 'sampleVersion': SAMPLE_VERSION,
           'pages': [fog_page, real_page]}
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    write_export_jobs()
    count = [0]

    def cnt(lst):
        for n in lst:
            count[0] += 1
            cnt(n.get('children', []))
    for pg in doc['pages']:
        cnt(pg['children'])
    print(f'wrote {OUT} ({os.path.getsize(OUT) // 1024} KB, {count[0]} nodes)')


def write_export_jobs():
    """Every real position on its own, both pages whole, and the lone start board."""
    slugs = ['start'] + [re.sub(r'[.…]\s*', '-', label) for _, _, label in PLIES]  # '1… Nf6' -> '1-Nf6'
    jobs = [{'nodes': [f'real-panel-{k}'], 'file': f'real-{k}-{s}', 'pad': 24, 'bg': SECTION_FILL, 'scale': 2}
            for k, s in enumerate(slugs)]
    jobs += [
        {'nodes': ['real-section'], 'file': 'real-positions-all', 'pad': 0, 'scale': 1},
        {'nodes': ['fog-section'], 'file': 'whites-view-all', 'pad': 0, 'scale': 1},
        {'nodes': ['start-section'], 'file': 'whites-view-start', 'pad': 0, 'scale': 2},
    ]
    with open(JOBS, 'w') as fh:
        json.dump({'doc': 'fog-of-war.json', 'out': 'exports', 'jobs': jobs}, fh, ensure_ascii=False, indent=2)
        fh.write('\n')


if __name__ == '__main__':
    main()
