"""Static file server for development with caching disabled (fresh ES modules on every reload).
python tests/devserver.py [port]"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8781
ThreadingHTTPServer(('127.0.0.1', port), partial(NoCache, directory='.')).serve_forever()
