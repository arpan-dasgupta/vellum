"""Turn PNG frames into a looping, transparent animated GIF. Standard library only.

    python3 tools/make_gif.py <out.gif> <frame.png> [<frame.png> ...] [--delay 8] [--matte F9F9F9]

Frames are RGBA PNGs of the same size. Fully transparent pixels stay transparent; partly
transparent edge pixels are blended onto the matte colour, so anti-aliased edges look right
on a background of that colour. Colours are reduced to one shared palette by median cut.
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path}: not a PNG')
    pos, idat = 8, b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
            if depth != 8 or ctype not in (2, 6) or interlace:
                raise SystemExit(f'{path}: need 8-bit RGB/RGBA, non-interlaced')
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    bpp = 4 if ctype == 6 else 3
    raw, stride = zlib.decompress(idat), w * bpp
    out, prev, i = bytearray(h * stride), bytearray(stride), 0
    for y in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    px = []
    for j in range(0, len(out), bpp):
        px.append((out[j], out[j + 1], out[j + 2], out[j + 3] if bpp == 4 else 255))
    return w, h, px


def median_cut(colors, n):
    """colors: {rgb: count}. Returns up to n representative colours."""
    boxes = [list(colors.items())]
    while len(boxes) < n:
        boxes.sort(key=lambda bx: -max(max(c[0][ch] for c in bx) - min(c[0][ch] for c in bx) for ch in range(3)) if len(bx) > 1 else 0)
        box = boxes.pop(0)
        if len(box) < 2:
            boxes.append(box)
            break
        ch = max(range(3), key=lambda k: max(c[0][k] for c in box) - min(c[0][k] for c in box))
        box.sort(key=lambda c: c[0][ch])
        total, acc, cut = sum(c[1] for c in box), 0, 1
        for idx, c in enumerate(box):
            acc += c[1]
            if acc >= total / 2:
                cut = max(1, min(len(box) - 1, idx + 1))
                break
        boxes += [box[:cut], box[cut:]]
    pal = []
    for bx in boxes:
        t = sum(c[1] for c in bx)
        pal.append(tuple(round(sum(c[0][k] * c[1] for c in bx) / t) for k in range(3)))
    return pal


def lzw(indices, min_size=8):
    clear, eoi = 1 << min_size, (1 << min_size) + 1
    size, nxt = min_size + 1, eoi + 1
    table = {bytes([i]): i for i in range(clear)}
    out, buf, nbits = bytearray(), 0, 0

    def emit(code):
        nonlocal buf, nbits
        buf |= code << nbits
        nbits += size
        while nbits >= 8:
            out.append(buf & 255)
            buf >>= 8
            nbits -= 8

    emit(clear)
    w = bytes([indices[0]])
    for k in indices[1:]:
        wk = w + bytes([k])
        if wk in table:
            w = wk
            continue
        emit(table[w])
        if nxt < 4096:
            table[wk] = nxt
            nxt += 1
            if nxt > (1 << size) and size < 12:
                size += 1
        else:
            emit(clear)
            table = {bytes([i]): i for i in range(clear)}
            size, nxt = min_size + 1, eoi + 1
        w = bytes([k])
    emit(table[w])
    emit(eoi)
    if nbits:
        out.append(buf & 255)
    return bytes(out)


def main():
    args = sys.argv[1:]
    delay, matte = 8, (0xF9, 0xF9, 0xF9)
    if '--delay' in args:
        i = args.index('--delay'); delay = int(args[i + 1]); del args[i:i + 2]
    if '--matte' in args:
        i = args.index('--matte'); m = args[i + 1]; matte = tuple(int(m[j:j + 2], 16) for j in (0, 2, 4)); del args[i:i + 2]
    out_path, frame_paths = args[0], args[1:]
    frames = [read_png(p) for p in frame_paths]
    w, h = frames[0][0], frames[0][1]
    # Flatten: transparent stays transparent, partial alpha blends onto the matte.
    flat, counts = [], {}
    for _, _, px in frames:
        fr = []
        for r, g, b, a in px:
            if a < 24:
                fr.append(None)
                continue
            if a < 255:
                t = a / 255
                r, g, b = (round(r * t + matte[0] * (1 - t)), round(g * t + matte[1] * (1 - t)), round(b * t + matte[2] * (1 - t)))
            fr.append((r, g, b))
            counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
        flat.append(fr)
    palette = median_cut(counts, 255) if len(counts) > 255 else list(counts)
    transparent = len(palette)
    palette = palette + [matte] * (256 - len(palette))
    cache = {}

    def nearest(c):
        if c not in cache:
            cache[c] = min(range(transparent), key=lambda i: (palette[i][0] - c[0]) ** 2 + (palette[i][1] - c[1]) ** 2 + (palette[i][2] - c[2]) ** 2)
        return cache[c]

    gif = bytearray(b'GIF89a' + struct.pack('<HHBBB', w, h, 0xF7, 0, 0))
    gif += bytes(v for c in palette for v in c)
    gif += b'\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00'  # loop forever
    for fr in flat:
        idx = bytes(transparent if c is None else nearest(c) for c in fr)
        gif += b'\x21\xF9\x04' + bytes([0b00001001]) + struct.pack('<H', delay) + bytes([transparent, 0])  # restore to background, transparency
        gif += b'\x2C' + struct.pack('<HHHHB', 0, 0, w, h, 0)
        data = lzw(idx)
        gif += b'\x08'
        for j in range(0, len(data), 255):
            chunk = data[j:j + 255]
            gif += bytes([len(chunk)]) + chunk
        gif += b'\x00'
    gif += b'\x3B'
    open(out_path, 'wb').write(gif)
    print(f'{out_path}: {len(frames)} frames, {w}x{h}, {transparent} colours, {len(gif) // 1024} KB')


if __name__ == '__main__':
    main()
