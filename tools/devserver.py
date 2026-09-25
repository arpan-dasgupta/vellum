"""Static dev server for Vellum that can also save rendered files to disk.

    python3 tools/devserver.py [port]      (default 8765; binds to 127.0.0.1)

GET  serves files from the vellum/ folder.
POST /save?path=<relative path>  writes the request body to that file, creating folders.
     The path must end in .svg, .png, .gif or .json and lie inside a folder named `exports`
     or under `.tmp/`, so a save can never overwrite the app, a document or a build script.
"""
import http.server
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PATH_OK = re.compile(r'^[A-Za-z0-9._/-]+\.(svg|png|gif|json)$')


def save_target(rel):
    """The absolute file a save may write for `rel`, or None if it isn't allowed."""
    if not PATH_OK.match(rel):
        return None
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        return None
    if parts[0] != '.tmp' and 'exports' not in parts[:-1]:
        return None
    full = os.path.abspath(os.path.join(ROOT, *parts))
    return full if full.startswith(ROOT + os.sep) else None


SKELETON = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                      '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        # Artifact pages are body fragments; wrap them like the Artifact host does.
        path = urlparse(self.path).path
        if path in ('/', '/index.html'):
            with open(os.path.join(ROOT, 'index.html'), 'rb') as fh:
                body = fh.read()
            if not body.lstrip().lower().startswith(b'<!doctype'):
                body = SKELETON.encode() + body + b'</body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        url = urlparse(self.path)
        rel = parse_qs(url.query).get('path', [''])[0]
        target = save_target(rel) if url.path == '/save' else None
        if not target:
            self.send_error(400, 'expected /save?path=<.tmp/... or .../exports/...>.svg|png|gif|json')
            return
        length = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(length)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as fh:
            fh.write(data)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(f'saved {rel} ({len(data)} bytes)'.encode())


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
