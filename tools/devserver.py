"""Static dev server for Vellum that can also save exports to disk.

GET  serves files from the vellum/ folder.
POST /save?name=<file>  writes the request body to vellum/exports/<file>.
Only plain file names ending in .svg, .png or .json are accepted; it binds to 127.0.0.1.
"""
import http.server
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EXPORTS = os.path.join(ROOT, 'exports')
NAME_OK = re.compile(r'^[A-Za-z0-9._-]+\.(svg|png|json)$')


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
        name = parse_qs(url.query).get('name', [''])[0]
        if url.path != '/save' or not NAME_OK.match(name):
            self.send_error(400, 'expected /save?name=<file>.svg|png|json')
            return
        length = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(length)
        os.makedirs(EXPORTS, exist_ok=True)
        with open(os.path.join(EXPORTS, name), 'wb') as fh:
            fh.write(data)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(f'saved {name} ({len(data)} bytes)'.encode())


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
