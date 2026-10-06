#!/usr/bin/env python3
"""Serve a Breezy board and save edits back into its self-contained HTML file."""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

APP = Path(__file__).resolve().parent / "app"
JS_ORDER = ["model.js", "view.js", "store.js", "input.js", "main.js"]
DATA_RE = re.compile(r'<script type="application/json" id="board-data">(.*?)</script>', re.DOTALL)
PLACEHOLDER_RE = re.compile(r"/\*(CSS|DATA|JS)\*/")
BACKUPS_KEPT = 50
BACKUP_INTERVAL = 600


class Conflict(Exception):
    def __init__(self, rev):
        super().__init__(f"board is at rev {rev}")
        self.rev = rev


def empty_data():
    return {"rev": 0, "view": {"x": 0, "y": 0, "zoom": 1}, "cards": [], "lanes": []}


def validate(data):
    ok = (isinstance(data, dict) and isinstance(data.get("rev"), int)
          and isinstance(data.get("view"), dict)
          and isinstance(data.get("cards"), list) and isinstance(data.get("lanes"), list))
    if not ok:
        raise ValueError("expected an object with rev, view, cards and lanes")


def assemble(data, app=APP):
    parts = {
        "CSS": (app / "board.css").read_text(encoding="utf-8"),
        "JS": "\n".join((app / name).read_text(encoding="utf-8") for name in JS_ORDER),
        # escaped so card text cannot close the script element
        "DATA": json.dumps(data, ensure_ascii=False).replace("<", "\\u003c"),
    }
    template = (app / "index.html").read_text(encoding="utf-8")
    # one pass, so inserted text is never scanned for placeholders
    return PLACEHOLDER_RE.sub(lambda m: parts[m.group(1)], template)


def extract(html):
    match = DATA_RE.search(html)
    if not match:
        raise ValueError("no board data found")
    data = json.loads(match.group(1))
    validate(data)
    return data


class BoardFile:
    def __init__(self, path, app=APP, backup_interval=BACKUP_INTERVAL):
        self.path = Path(path)
        self.app = app
        self.backup_interval = backup_interval
        self.backups = self.path.parent / "backups"

    def ensure(self):
        """Creates an empty board if missing; raises ValueError for a file that is not a board."""
        if self.path.exists():
            self.load()
        else:
            self._write(assemble(empty_data(), self.app))

    def load(self):
        return extract(self.path.read_text(encoding="utf-8"))

    def page(self):
        return assemble(self.load(), self.app)

    def save(self, data):
        validate(data)
        rev = self.load()["rev"]
        if data["rev"] != rev:
            raise Conflict(rev)
        self._backup()
        self._write(assemble({**data, "rev": rev + 1}, self.app))
        return rev + 1

    def _backup(self):
        self.backups.mkdir(exist_ok=True)
        pattern = f"{self.path.stem}-*.html"
        existing = sorted(self.backups.glob(pattern))
        if existing and time.time() - existing[-1].stat().st_mtime < self.backup_interval:
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copyfile(self.path, self.backups / f"{self.path.stem}-{stamp}.html")
        for old in sorted(self.backups.glob(pattern))[:-BACKUPS_KEPT]:
            old.unlink()

    def _write(self, html):
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(html)
        os.chmod(tmp, 0o644)
        os.replace(tmp, self.path)


def make_handler(board):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if not self._allowed():
                return
            if urlsplit(self.path).path != "/":
                return self.send_error(404)
            self._send(200, "text/html; charset=utf-8", board.page())

        def do_PUT(self):
            if not self._allowed():
                return
            if urlsplit(self.path).path != "/data":
                return self.send_error(404)
            try:
                length = int(self.headers.get("Content-Length", 0))
                rev = board.save(json.loads(self.rfile.read(length)))
            except Conflict as e:
                return self._send(409, "application/json", json.dumps({"rev": e.rev}))
            except ValueError as e:
                return self._send(400, "application/json", json.dumps({"error": str(e)}))
            self._send(200, "application/json", json.dumps({"rev": rev}))

        def _allowed(self):
            # blocks DNS rebinding: other sites cannot reach the board via a hostname resolving to 127.0.0.1
            port = self.server.server_address[1]
            if self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}"):
                return True
            self.send_error(403)
            return False

        def _send(self, status, content_type, body):
            payload = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve a Breezy board and save edits into it.")
    parser.add_argument("board", nargs="?", default="board.html", help="board file (default: board.html)")
    parser.add_argument("--port", type=int, default=64570)
    args = parser.parse_args(argv)
    board = BoardFile(args.board)
    try:
        board.ensure()
    except ValueError as e:
        sys.exit(f"breezy: {args.board}: {e}")
    server = HTTPServer(("127.0.0.1", args.port), make_handler(board))
    print(f"Breezy: http://localhost:{args.port}/ ({board.path.resolve()})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
