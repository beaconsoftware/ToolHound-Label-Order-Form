"""Serve the static app locally with its canonical admin routes."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode

PUBLIC = Path(__file__).resolve().parent.parent / 'public'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)
    def send_head(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        target = None
        if url.path in ('/admin', '/admin/', '/admin.html'):
            target = '/admin/prepare-order' if query.pop('view', [''])[0] == 'prepare' else '/admin/orders'
        elif url.path in ('/prepare-order', '/prepare-order/', '/prepare-order.html'):
            target = '/admin/prepare-order'
        elif url.path in ('/admin/orders/', '/admin/prepare-order/'):
            target = url.path.rstrip('/')
        if target:
            self.send_response(308)
            self.send_header('Location', target + ('?' + urlencode(query, doseq=True) if query else ''))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        if url.path in ('/admin/orders', '/admin/prepare-order'):
            self.path = '/admin.html'
        elif not Path(url.path).suffix and (PUBLIC / (url.path.lstrip('/') + '.html')).is_file():
            self.path = url.path + '.html'
        return super().send_head()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
