#!/usr/bin/env python3
"""Dev server for FluidLab.

Plain http.server caches ES modules aggressively enough that an edited file keeps
serving the old version — which cost real debugging time. This sends no-store so a
reload always gets what is on disk.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *args):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
print(f'FluidLab → http://localhost:{port}')
ThreadingHTTPServer(('', port), Handler).serve_forever()
