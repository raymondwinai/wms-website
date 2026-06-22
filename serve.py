#!/usr/bin/env python3
import os
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "3000"))


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = partial(Handler, directory=ROOT)
    httpd = HTTPServer(("127.0.0.1", PORT), handler)
    print(f"Serving {ROOT} at http://localhost:{PORT}")
    httpd.serve_forever()
