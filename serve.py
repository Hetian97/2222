#!/usr/bin/env python3
"""Local static server + same-origin Catbox upload proxy.

Run from this directory:
    python serve.py
Then open http://127.0.0.1:8123/index.html

The proxy endpoint is intentionally limited to Catbox's upload API, so the
browser can use Catbox from a local page without exposing a general-purpose
proxy on the network.
"""
import argparse
import http.server
import urllib.error
import urllib.request


CATBOX_ENDPOINT = 'https://catbox.moe/user/api.php'


class Handler(http.server.SimpleHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path.split('?', 1)[0] != '/catbox-proxy':
            self.send_error(404)
            return

        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_error(400, 'Missing request body')
            return

        body = self.rfile.read(length)
        content_type = self.headers.get('Content-Type', '')
        request = urllib.request.Request(
            CATBOX_ENDPOINT,
            data=body,
            method='POST',
            headers={
                'Content-Type': content_type,
                'User-Agent': 'EPhone-local-catbox-proxy/1.0',
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            payload = error.read()
            status = error.code
        except Exception as error:
            payload = str(error).encode('utf-8', errors='replace')
            status = 502

        self.send_response(status if status < 500 else 502)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8123)
    parser.add_argument('--bind', default='127.0.0.1')
    args = parser.parse_args()

    server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f'Serving at http://{args.bind}:{args.port}/index.html')
    print('Catbox proxy: /catbox-proxy')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
