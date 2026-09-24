"""Build samples/fog-of-war.json: a Vellum replica of the FigJam Fog of War boards.

Page 1 "White's view" mirrors the FigJam board: the single starting board and the
7-move sequence as White sees it. Page 2 "Real positions" shows the same seven
moves with the fog lifted.

Run: python3 tools/build_fow.py
"""
import json
import os

FILES = 'abcdefgh'
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_VERSION = 2  # bump when the sample changes, so the editor offers the new version
OUT = os.path.join(HERE, '..', 'samples', 'fog-of-war.json')

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


def board_nodes(ox, oy, S, pos, fog, board_id, whole_fog_rect=False, theme=CLASSIC):
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
            if f == 0:
                labels.append(text(f'Rank {r}', x + 3, y + 2, str(r), fs, 500, lab_col))
            if r == 1:
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


def arrow(from_id, to_id, label, hidden):
    return {'id': nid('c'), 'type': 'CONNECTOR', 'name': ('Hidden Black move ' if hidden else 'Move ') + label,
            'from': {'id': from_id, 'side': 'RIGHT'}, 'to': {'id': to_id, 'side': 'LEFT'},
            'label': label, 'labelSize': 18, 'stroke': GREY if hidden else CHAR, 'strokeWidth': 3,
            'dash': '10 6' if hidden else None, 'arrow': True}

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

S, BW, PAD, GAP, TOP = 56, 448, 48, 180, 210
REAL_GAP = 140  # from the bottom of a fogged board to the real-position label below it
HEAD_W = {'1…': 33.1, '2…': 37.9, '3…': 37.7}  # measured Inter Semi Bold 24px widths
REAL_LABELS = ['Real position: start', 'Real position after 1. e4', 'Real position after 1… Nf6',
               'Real position after 2. Nc3', 'Real position after 2… d6', 'Real position after 3. Bb5',
               'Real position after 3… g6', 'Real position after 4. Bxe8']
SEQ_X, SEQ_Y = 1000, 200


def sequence_section(title, intro, move_line, texts, fogged, prefix):
    pos = positions()
    kids = [
        text('Title', SEQ_X + PAD, SEQ_Y + 40, title, 40, 600),
        text('Intro', SEQ_X + PAD, SEQ_Y + 98, intro, 16, 500, GREY, w=8 * BW + 7 * GAP),
    ]
    lead = 'What actually happened:'
    ml = text('Move list', SEQ_X + PAD, SEQ_Y + 138, move_line, 24, 600)
    if fogged:
        ml['runs'] = [{'text': lead, 'color': GREY}, {'text': move_line[len(lead):], 'color': CHAR}]
    kids.append(ml)
    board_ids = []
    for k, p in enumerate(pos):
        ox, oy = SEQ_X + PAD + k * (BW + GAP), SEQ_Y + TOP
        by = oy + 44
        head_txt = texts[k][0]
        hidden = fogged and p['side'] == 'b'
        pk = [text('Heading', ox, oy, head_txt, 24, 600)]
        if hidden:
            tx = ox + HEAD_W.get(head_txt, 40) + 12
            pk.append(rect('Hidden move tag', tx, oy + 2.5, 100, 24, GREY, radius=12))
            pk.append(text('Hidden move', tx, oy + 2.5 + (24 - 13 * 1.3) / 2, 'Hidden move', 13, 600, WHITE,
                           w=100, align='center', lineHeight=1.3))
        bid = f'{prefix}-board-{k}'
        board_ids.append(bid)
        pk += board_nodes(ox, by, S, p, fogged, bid)
        if fogged:
            pk.append(caption(ox, by + BW + 14, BW, texts[k][1], texts[k][2]))
            # The real position, fog lifted, in the blue-and-black theme.
            ry = by + BW + REAL_GAP
            pk.append(text('Real position label', ox, ry, REAL_LABELS[k], 18, 600, CHAR))
            pk.append(group('Real position', board_nodes(ox, ry + 34, S, p, False, f'{prefix}-real-board-{k}', theme=BLUE),
                            id=f'{prefix}-real-{k}'))
        else:
            pk.append(caption(ox, by + BW + 14, BW, texts[k][1]))
        kids.append(group(f'Position {k} · {head_txt}', pk, id=f'{prefix}-panel-{k}'))
    labels = ([t[0] for t in FOG_TEXT[1:]] if fogged else [t[0] for t in REAL_TEXT[1:]])
    if fogged:
        labels = ['1. e4', '1…', '2. Nc3', '2…', '3. Bb5', '3…', '4. Bxe8']
    for k in range(7):
        kids.append(arrow(board_ids[k], board_ids[k + 1], labels[k], fogged and k % 2 == 1))
    w = PAD * 2 + 8 * BW + 7 * GAP
    h = (TOP + 44 + BW + REAL_GAP + 34 + BW + PAD) if fogged else 840
    return section('Fog of War — 7-move sequence' if fogged else 'Real positions', SEQ_X, SEQ_Y, w, h, kids,
                   id=f'{prefix}-section')


def start_section():
    p0 = positions()[0]
    S0, bx, by = 80, 240, 310
    kids = [text('Title', 240, 232, 'Fog of War — Starting position (White to move)', 24, 600)]
    kids += board_nodes(bx, by, S0, p0, True, 'start-board', whole_fog_rect=True)
    kids.append(text('Caption', bx, by + 8 * S0 + 16,
                     'White sees only squares its pieces can move to: ranks 1–4. Ranks 5–8 and all of Black’s pieces are hidden in fog.',
                     14, 500, GREY, w=8 * S0, lineHeight=1.3))
    ry = by + 8 * S0 + 90
    kids.append(text('Real position label', bx, ry, 'Real position: every piece, no fog', 18, 600, CHAR))
    kids.append(group('Real position', board_nodes(bx, ry + 34, S0, p0, False, 'start-real-board', theme=BLUE),
                      id='start-real'))
    h = ry + 34 + 8 * S0 + 40 - 200
    return section('Fog of War — Start', 200, 200, 720, h, kids, id='start-section')


def main():
    fog_page = {'id': 'page-view', 'name': 'White’s view', 'children': [
        start_section(),
        sequence_section('Fog of War: seven moves through White’s eyes',
                         'Each board is exactly what White sees after every move, White’s and Black’s. Fogged squares '
                         'are ones no White piece could move to. When Black moves, White learns nothing unless something '
                         'in view changes. Under each board, in blue, is where every piece really stood.',
                         'What actually happened:   1. e4 Nf6    2. Nc3 d6    3. Bb5 g6    4. Bxe8',
                         FOG_TEXT, True, 'fog'),
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
    count = [0]

    def cnt(lst):
        for n in lst:
            count[0] += 1
            cnt(n.get('children', []))
    for pg in doc['pages']:
        cnt(pg['children'])
    print(f'wrote {OUT} ({os.path.getsize(OUT) // 1024} KB, {count[0]} nodes)')


if __name__ == '__main__':
    main()
