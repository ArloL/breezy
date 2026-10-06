# Breezy Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mural-style personal whiteboard (cards, lanes, infinite canvas) stored in one self-contained HTML file, saved by a tiny local server.

**Architecture:** Plain browser JS in `app/` (model / view / store / input / main), concatenated with CSS and the board's JSON into `board.html` by `breezy.py`. The server serves the assembled page and accepts `PUT /data` to rewrite the file atomically, with backups and a revision check.

**Tech Stack:** Python 3 stdlib (server, `unittest`), plain ES2022 browser JS, Node's built-in test runner for the model. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-breezy-board-design.md`

## Global Constraints

- No third-party dependencies anywhere. Python stdlib only; browser JS without build tools; Node only to run `node --test`.
- Firefox (current release) is the primary browser: no Chrome-only APIs.
- Server binds `127.0.0.1`, default port `64570`.
- Grid 20 px; card width 200; new lane 400 × 600, minimum 100 × 100; zoom 0.25–2; undo 100 steps.
- Save 500 ms after a change; retry every 5 s when the server is unreachable.
- Backups: `backups/` next to the board file, at most one per 10 minutes, newest 50 kept.
- Code comments: only what the code cannot say.
- Commit messages end with the line `Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg`.

## Review Focus

1. Card text containing `</script>`, `/*JS*/`, backslashes or non-ASCII → saved page still loads and the text is identical. (Task 1 `test_card_text_cannot_break_the_page`)
2. Starting the server on a file that is not a Breezy board or has broken JSON → refuses to start, file untouched. (Task 1 `test_ensure_refuses_a_file_that_is_not_a_board`, `test_extract_rejects_foreign_html`)
3. Malformed `PUT` body → 400, file untouched. (Task 1 `test_invalid_data_is_rejected`, `test_put_garbage`)
4. Server stopped mid-session → status says so, edits stay in the page and are saved once the server is back; closing the tab with unsaved changes warns. (Task 3 manual check)
5. Gestures that change nothing (click a card, open and close an editor) → no empty undo steps; redo still works afterwards. (Task 2 `a no-op gesture keeps redo available`, `editing an existing card without changes leaves no undo step`)

## File Map

| File | Responsibility |
|---|---|
| `breezy.py` | page assembly, data extraction, `BoardFile` (load/save/backup), HTTP handler, CLI |
| `app/index.html` | page template with `/*CSS*/`, `/*DATA*/`, `/*JS*/` placeholders |
| `app/board.css` | all styles |
| `app/model.js` | `Board`: state, operations, snapping, hit tests, undo; `zoomAt`; no DOM |
| `app/view.js` | `View`: renders state to DOM, selection, editors, coordinate conversion |
| `app/store.js` | `Store`: debounced save, status, read-only detection |
| `app/input.js` | `Input`: pointer, wheel and keyboard events → `Board` operations |
| `app/main.js` | wires the four together |
| `tests/test_breezy.py` | server tests |
| `tests/model.test.js` | model tests |

---

### Task 1: Server and page assembly

**Files:**
- Create: `breezy.py`, `app/index.html`, `tests/test_breezy.py`, `.gitignore`

**Interfaces:**
- Produces: `breezy.JS_ORDER = ["model.js", "view.js", "store.js", "input.js", "main.js"]`; `assemble(data, app=APP) -> str`; `extract(html) -> dict` (raises `ValueError`); `BoardFile(path, app=APP, backup_interval=600)` with `ensure()`, `load()`, `page()`, `save(data) -> int` (raises `Conflict`, `ValueError`); `make_handler(board)`; HTTP `GET /` and `PUT /data` → `{"rev": n}` (200), `{"rev": n}` (409), `{"error": msg}` (400). Page element ids used by later tasks: `board`, `world`, `lanes`, `cards`, `marquee`, `toolbar`, `add-lane`, `status`, `board-data`.

- [ ] **Step 1: Write the failing tests**

`tests/test_breezy.py`:

```python
import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import breezy

TEMPLATE = ('<style>/*CSS*/</style>'
            '<script type="application/json" id="board-data">/*DATA*/</script>'
            '<script>/*JS*/</script>')


def make_app(root):
    app = root / "app"
    app.mkdir()
    (app / "index.html").write_text(TEMPLATE)
    (app / "board.css").write_text("body{}")
    for name in breezy.JS_ORDER:
        (app / name).write_text(f"// {name}")
    return app


def data(rev=0, text="hello"):
    return {"rev": rev, "view": {"x": 0, "y": 0, "zoom": 1},
            "cards": [{"id": "c1", "x": 0, "y": 0, "w": 200, "text": text, "color": 1}],
            "lanes": []}


class TempDir(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.app = make_app(self.root)
        self.path = self.root / "board.html"

    def board(self, **kwargs):
        return breezy.BoardFile(self.path, app=self.app, **kwargs)

    def backups(self):
        return sorted(p.name for p in (self.root / "backups").glob("board-*.html"))


class AssembleTest(TempDir):
    def test_round_trip(self):
        page = breezy.assemble(data(), self.app)
        self.assertIn("// main.js", page)
        self.assertIn("body{}", page)
        self.assertEqual(breezy.extract(page), data())

    def test_card_text_cannot_break_the_page(self):
        tricky = '</script><script>alert(1)</script> /*JS*/ /*DATA*/ \\n "q" ü'
        page = breezy.assemble(data(text=tricky), self.app)
        self.assertEqual(page.count("</script>"), 2)
        self.assertEqual(page.count("// model.js"), 1)
        self.assertEqual(breezy.extract(page)["cards"][0]["text"], tricky)

    def test_extract_rejects_foreign_html(self):
        with self.assertRaises(ValueError):
            breezy.extract("<html><body>notes</body></html>")
        with self.assertRaises(ValueError):
            breezy.extract('<script type="application/json" id="board-data">{oops</script>')


class BoardFileTest(TempDir):
    def test_ensure_creates_an_empty_board(self):
        self.board().ensure()
        self.assertEqual(self.board().load(), breezy.empty_data())

    def test_ensure_refuses_a_file_that_is_not_a_board(self):
        self.path.write_text("my notes")
        with self.assertRaises(ValueError):
            self.board().ensure()
        self.assertEqual(self.path.read_text(), "my notes")

    def test_save_increments_rev(self):
        board = self.board()
        board.ensure()
        self.assertEqual(board.save(data(rev=0)), 1)
        self.assertEqual(board.load(), data(rev=1))

    def test_stale_rev_is_rejected(self):
        board = self.board()
        board.ensure()
        board.save(data(rev=0))
        before = self.path.read_text()
        with self.assertRaises(breezy.Conflict) as ctx:
            board.save(data(rev=0, text="other tab"))
        self.assertEqual(ctx.exception.rev, 1)
        self.assertEqual(self.path.read_text(), before)

    def test_invalid_data_is_rejected(self):
        board = self.board()
        board.ensure()
        before = self.path.read_text()
        for bad in ([], {"rev": 0}, {**data(), "cards": "x"}):
            with self.assertRaises(ValueError):
                board.save(bad)
        self.assertEqual(self.path.read_text(), before)

    def test_save_backs_up_the_previous_version(self):
        board = self.board(backup_interval=0)
        board.ensure()
        original = self.path.read_text()
        board.save(data(rev=0))
        names = self.backups()
        self.assertEqual(len(names), 1)
        self.assertEqual((self.root / "backups" / names[0]).read_text(), original)

    def test_backups_are_throttled(self):
        board = self.board(backup_interval=600)
        board.ensure()
        board.save(data(rev=0))
        board.save(data(rev=1))
        self.assertEqual(len(self.backups()), 1)

    def test_backups_are_pruned_to_50(self):
        board = self.board(backup_interval=0)
        board.ensure()
        folder = self.root / "backups"
        folder.mkdir()
        for i in range(55):
            (folder / f"board-20200101-000000-{i:06d}.html").write_text("old")
        board.save(data(rev=0))
        names = self.backups()
        self.assertEqual(len(names), 50)
        self.assertNotIn("board-20200101-000000-000005.html", names)
        self.assertIn("board-20200101-000000-000006.html", names)


class ServerTest(TempDir):
    def setUp(self):
        super().setUp()
        self.board().ensure()
        self.server = HTTPServer(("127.0.0.1", 0), breezy.make_handler(self.board()))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def request(self, method, path, body=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request(method, path, body=body, headers={"Host": host or f"127.0.0.1:{self.port}"})
        res = conn.getresponse()
        result = res.status, res.read().decode()
        conn.close()
        return result

    def test_get_serves_the_page(self):
        status, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(breezy.extract(body), breezy.empty_data())

    def test_put_saves(self):
        status, body = self.request("PUT", "/data", json.dumps(data(rev=0)))
        self.assertEqual((status, json.loads(body)), (200, {"rev": 1}))
        self.assertEqual(self.board().load(), data(rev=1))

    def test_put_conflict(self):
        self.request("PUT", "/data", json.dumps(data(rev=0)))
        status, body = self.request("PUT", "/data", json.dumps(data(rev=0)))
        self.assertEqual((status, json.loads(body)), (409, {"rev": 1}))

    def test_put_garbage(self):
        self.assertEqual(self.request("PUT", "/data", "not json")[0], 400)

    def test_foreign_host_is_refused(self):
        self.assertEqual(self.request("GET", "/", host="evil.example:64570")[0], 403)

    def test_unknown_path(self):
        self.assertEqual(self.request("GET", "/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest discover --start-directory tests`
Expected: error `ModuleNotFoundError: No module named 'breezy'`

- [ ] **Step 3: Write the template and the server**

`app/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breezy</title>
<style>/*CSS*/</style>
</head>
<body>
<div id="board"><div id="world"><div id="lanes"></div><div id="cards"></div><div id="marquee" hidden></div></div></div>
<div id="toolbar"><button id="add-lane" title="New lane (L)">+ Lane</button><span id="status"></span></div>
<script type="application/json" id="board-data">/*DATA*/</script>
<script>/*JS*/</script>
</body>
</html>
```

`breezy.py`:

```python
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
```

`.gitignore`:

```
board.html
backups/
__pycache__/
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest discover --start-directory tests`
Expected: `Ran 17 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add breezy.py app/index.html tests/test_breezy.py .gitignore
git commit --message "Add board server and page assembly

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```

---

### Task 2: Board model

**Files:**
- Create: `app/model.js`, `tests/model.test.js`

**Interfaces:**
- Consumes: data shape `{rev, view: {x, y, zoom}, cards: [{id, x, y, w, text, color}], lanes: [{id, x, y, w, h, title}]}`.
- Produces (globals in the browser, `module.exports` in Node): `GRID`, `CARD_W`, `LANE_W`, `LANE_H`, `snap(v)`, `zoomAt(view, sx, sy, factor) -> {x, y, zoom}`, and `class Board(data, onChange)` with:
  - `data`, `onChange`, `undoStack`, `redoStack`, `changed()`, `card(id)`, `lane(id)`
  - `checkpoint()`: call before a gesture or edit; `dropNoopCheckpoint()`: call when it ends
  - `undo()`, `redo()`
  - `addCard(x, y) -> card` (own checkpoint), `setText(id, text)`, `setLaneTitle(id, title)`, `finishEdit(id)`
  - `moveCards(origins, dx, dy)` with `origins: [{id, x, y}]`
  - `setColor(ids, color)`, `remove(ids)` (own checkpoints; no-ops when nothing matches)
  - `addLane(x, y) -> lane` (own checkpoint), `moveLane(origin, cardOrigins, dx, dy)` with `origin: {id, x, y}`, `resizeLane(id, w, h)`
  - `cardsInLane(id, heightOf) -> card[]`, `cardsInRect({x, y, w, h}, heightOf) -> card[]`; `heightOf(id) -> number`
  - Every mutating method calls `changed()`.

- [ ] **Step 1: Write the failing tests**

`tests/model.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { GRID, CARD_W, snap, zoomAt, Board } = require("../app/model.js");

const board = (cards = [], lanes = []) => new Board({ rev: 0, view: { x: 0, y: 0, zoom: 1 }, cards, lanes });
const card = (id, x, y, text = "t") => ({ id, x, y, w: CARD_W, text, color: 1 });
const lane = (id, x, y, w = 400, h = 600) => ({ id, x, y, w, h, title: "Lane" });
const h40 = () => 40;

test("snap rounds to the nearest grid line", () => {
  assert.equal(GRID, 20);
  assert.equal(snap(29), 20);
  assert.equal(snap(31), 40);
  assert.equal(snap(-31), -40);
});

test("addCard snaps and starts empty", () => {
  const b = board();
  const c = b.addCard(33, 47);
  assert.deepEqual({ x: c.x, y: c.y, w: c.w, text: c.text, color: c.color }, { x: 40, y: 40, w: 200, text: "", color: 1 });
  assert.equal(b.data.cards.length, 1);
});

test("a new card left blank disappears without an undo step", () => {
  const b = board();
  const c = b.addCard(0, 0);
  b.setText(c.id, "  \n ");
  b.finishEdit(c.id);
  assert.equal(b.data.cards.length, 0);
  assert.equal(b.undoStack.length, 0);
});

test("finishEdit trims trailing whitespace and the new card undoes in one step", () => {
  const b = board();
  const c = b.addCard(0, 0);
  b.setText(c.id, "Idea\nmore\n\n");
  b.finishEdit(c.id);
  assert.equal(b.card(c.id).text, "Idea\nmore");
  b.undo();
  assert.equal(b.data.cards.length, 0);
});

test("editing an existing card without changes leaves no undo step", () => {
  const b = board([card("a", 0, 0, "x")]);
  b.checkpoint();
  b.finishEdit("a");
  assert.equal(b.undoStack.length, 0);
});

test("a no-op gesture keeps redo available", () => {
  const b = board([card("a", 0, 0)]);
  b.setColor(["a"], 3);
  b.undo();
  b.checkpoint();
  b.dropNoopCheckpoint();
  b.redo();
  assert.equal(b.card("a").color, 3);
});

test("moveCards snaps relative to the drag origins", () => {
  const b = board([card("a", 0, 0), card("b", 40, 20)]);
  b.moveCards([{ id: "a", x: 0, y: 0 }, { id: "b", x: 40, y: 20 }], 27, 9);
  assert.deepEqual([b.card("a").x, b.card("a").y, b.card("b").x, b.card("b").y], [20, 0, 60, 20]);
});

test("setColor changes cards only and skips empty selections", () => {
  const b = board([card("a", 0, 0)], [lane("l", 0, 0)]);
  b.setColor(["l"], 2);
  assert.equal(b.undoStack.length, 0);
  b.setColor(["a", "l"], 4);
  assert.equal(b.card("a").color, 4);
  assert.equal(b.lane("l").color, undefined);
});

test("remove deletes a lane but not the cards on it", () => {
  const b = board([card("a", 20, 60)], [lane("l", 0, 0)]);
  b.remove(["l"]);
  assert.deepEqual(b.data.lanes, []);
  assert.equal(b.data.cards.length, 1);
  b.remove(["a"]);
  assert.deepEqual(b.data.cards, []);
});

test("cardsInLane counts cards whose centre is inside", () => {
  const b = board([card("in", 300, 0), card("out", 320, 0)], [lane("l", 0, 0, 400, 600)]);
  assert.deepEqual(b.cardsInLane("l", h40).map((c) => c.id), ["in"]);
});

test("moveLane carries its cards by the snapped delta", () => {
  const b = board([card("a", 20, 60)], [lane("l", 0, 0)]);
  b.moveLane({ id: "l", x: 0, y: 0 }, [{ id: "a", x: 20, y: 60 }], 51, -12);
  assert.deepEqual([b.lane("l").x, b.lane("l").y], [60, -20]);
  assert.deepEqual([b.card("a").x, b.card("a").y], [80, 40]);
});

test("resizeLane snaps and keeps a minimum size", () => {
  const b = board([], [lane("l", 0, 0)]);
  b.resizeLane("l", 433, 10);
  assert.deepEqual([b.lane("l").w, b.lane("l").h], [440, 100]);
});

test("cardsInRect finds overlapping cards", () => {
  const b = board([card("a", 0, 0), card("b", 400, 400)]);
  assert.deepEqual(b.cardsInRect({ x: 190, y: 30, w: 50, h: 50 }, h40).map((c) => c.id), ["a"]);
});

test("undo and redo restore cards and lanes", () => {
  const b = board();
  b.addLane(0, 0);
  const c = b.addCard(0, 0);
  b.undo();
  assert.equal(b.card(c.id), undefined);
  b.undo();
  assert.deepEqual(b.data.lanes, []);
  b.redo();
  b.redo();
  assert.equal(b.data.lanes.length, 1);
  assert.ok(b.card(c.id));
});

test("undo history is capped at 100 steps", () => {
  const b = board([card("a", 0, 0)]);
  for (let i = 0; i < 120; i++) b.setColor(["a"], (i % 5) + 1);
  assert.equal(b.undoStack.length, 100);
});

test("zoomAt keeps the point under the cursor fixed and clamps", () => {
  const v = zoomAt({ x: 10, y: 20, zoom: 1 }, 110, 220, 2);
  assert.deepEqual(v, { x: -90, y: -180, zoom: 2 });
  assert.equal(zoomAt(v, 0, 0, 10).zoom, 2);
  assert.equal(zoomAt(v, 0, 0, 0.01).zoom, 0.25);
});

test("changes notify the listener", () => {
  let calls = 0;
  const b = new Board({ rev: 0, view: { x: 0, y: 0, zoom: 1 }, cards: [], lanes: [] }, () => calls++);
  b.addCard(0, 0);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL, `Cannot find module '../app/model.js'`

- [ ] **Step 3: Write the model**

`app/model.js`:

```js
const GRID = 20;
const CARD_W = 200;
const LANE_W = 400;
const LANE_H = 600;
const LANE_MIN = 100;
const UNDO_LIMIT = 100;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Zooms so that the screen point (sx, sy) stays over the same world point.
function zoomAt(view, sx, sy, factor) {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  const wx = (sx - view.x) / view.zoom;
  const wy = (sy - view.y) / view.zoom;
  return { x: sx - wx * zoom, y: sy - wy * zoom, zoom };
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

class Board {
  constructor(data, onChange = () => {}) {
    this.data = data;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
    this.redoBeforeGesture = [];
  }

  changed() {
    this.onChange();
  }

  card(id) {
    return this.data.cards.find((c) => c.id === id);
  }

  lane(id) {
    return this.data.lanes.find((l) => l.id === id);
  }

  snapshot() {
    return JSON.stringify([this.data.cards, this.data.lanes]);
  }

  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoBeforeGesture = this.redoStack;
    this.redoStack = [];
  }

  dropNoopCheckpoint() {
    if (this.undoStack.at(-1) !== this.snapshot()) return;
    this.undoStack.pop();
    this.redoStack = this.redoBeforeGesture;
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }

  redo() {
    this.step(this.redoStack, this.undoStack);
  }

  step(from, to) {
    if (!from.length) return;
    to.push(this.snapshot());
    [this.data.cards, this.data.lanes] = JSON.parse(from.pop());
    this.changed();
  }

  addCard(x, y) {
    this.checkpoint();
    const card = { id: newId("c"), x: snap(x), y: snap(y), w: CARD_W, text: "", color: 1 };
    this.data.cards.push(card);
    this.changed();
    return card;
  }

  setText(id, text) {
    this.card(id).text = text;
    this.changed();
  }

  setLaneTitle(id, title) {
    this.lane(id).title = title;
    this.changed();
  }

  // Ends editing a card or lane title. A blank card is removed.
  finishEdit(id) {
    const card = this.card(id);
    if (card) {
      card.text = card.text.trimEnd();
      if (!card.text) this.data.cards = this.data.cards.filter((c) => c !== card);
    }
    this.dropNoopCheckpoint();
    this.changed();
  }

  moveCards(origins, dx, dy) {
    for (const o of origins) {
      const c = this.card(o.id);
      if (!c) continue;
      c.x = snap(o.x + dx);
      c.y = snap(o.y + dy);
    }
    this.changed();
  }

  setColor(ids, color) {
    const cards = this.data.cards.filter((c) => ids.includes(c.id));
    if (!cards.length) return;
    this.checkpoint();
    for (const c of cards) c.color = color;
    this.changed();
  }

  remove(ids) {
    const keep = (x) => !ids.includes(x.id);
    if (this.data.cards.every(keep) && this.data.lanes.every(keep)) return;
    this.checkpoint();
    this.data.cards = this.data.cards.filter(keep);
    this.data.lanes = this.data.lanes.filter(keep);
    this.changed();
  }

  addLane(x, y) {
    this.checkpoint();
    const lane = { id: newId("l"), x: snap(x), y: snap(y), w: LANE_W, h: LANE_H, title: "Lane" };
    this.data.lanes.push(lane);
    this.changed();
    return lane;
  }

  moveLane(origin, cardOrigins, dx, dy) {
    const lane = this.lane(origin.id);
    lane.x = snap(origin.x + dx);
    lane.y = snap(origin.y + dy);
    const ddx = lane.x - origin.x;
    const ddy = lane.y - origin.y;
    for (const o of cardOrigins) {
      const c = this.card(o.id);
      if (!c) continue;
      c.x = o.x + ddx;
      c.y = o.y + ddy;
    }
    this.changed();
  }

  resizeLane(id, w, h) {
    const lane = this.lane(id);
    lane.w = Math.max(LANE_MIN, snap(w));
    lane.h = Math.max(LANE_MIN, snap(h));
    this.changed();
  }

  cardsInLane(id, heightOf) {
    const l = this.lane(id);
    return this.data.cards.filter((c) => {
      const cx = c.x + c.w / 2;
      const cy = c.y + heightOf(c.id) / 2;
      return cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h;
    });
  }

  cardsInRect(rect, heightOf) {
    return this.data.cards.filter((c) => intersects(rect, { x: c.x, y: c.y, w: c.w, h: heightOf(c.id) }));
  }
}

if (typeof module !== "undefined") module.exports = { GRID, CARD_W, LANE_W, LANE_H, snap, zoomAt, Board };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: `# pass 17`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add app/model.js tests/model.test.js
git commit --message "Add board model with snapping and undo

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```

---

### Task 3: Rendering, saving, pan and zoom

**Files:**
- Create: `app/board.css`, `app/view.js`, `app/store.js`, `app/input.js`, `app/main.js`
- Modify: `tests/test_breezy.py` (add `RealAppTest`)

**Interfaces:**
- Consumes: `Board`, `GRID`, `zoomAt` from Task 2; page ids from Task 1.
- Produces:
  - `class View(root, board)`: `render()`, `selected: Set`, `select(ids)`, `toggle(id)`, `heightOf(id)`, `toWorld(clientX, clientY) -> {x, y}`, `openCardEditor(id) -> HTMLTextAreaElement`, `openLaneEditor(id) -> HTMLInputElement`, `closeEditor()`, `fit(textarea)`, `showMarquee({x, y, w, h})`, `hideMarquee()`, `setStatus(text, isError)`.
  - `class Store(board, view)`: `readOnly`, `schedule(delay)`.
  - `class Input(view, board, store)`: `drag`, `pointer`, `editable`, `down(e)`, `move(e)`, `up()`, `wheel(e)`, `key(e)`. Tasks 4 and 5 extend it.

- [ ] **Step 1: Write the failing smoke test**

Append to `tests/test_breezy.py`, before `if __name__ == "__main__":`:

```python
class RealAppTest(unittest.TestCase):
    def test_real_app_assembles(self):
        page = breezy.assemble(breezy.empty_data())
        self.assertEqual(breezy.extract(page), breezy.empty_data())
        for name in breezy.JS_ORDER:
            self.assertIn((breezy.APP / name).read_text(encoding="utf-8"), page)
        self.assertIn((breezy.APP / "board.css").read_text(encoding="utf-8"), page)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest discover --start-directory tests`
Expected: `FileNotFoundError` for `app/board.css`

- [ ] **Step 3: Write styles, view, store, input and main**

`app/board.css`:

```css
html, body { margin: 0; height: 100%; overflow: hidden; }
body { font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #222; }

#board {
  position: fixed; inset: 0; cursor: default; touch-action: none;
  user-select: none; -webkit-user-select: none;
  background-color: #f4f3ef;
  background-image: radial-gradient(circle, #c9c6bd 1px, transparent 1.2px);
}
#world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }

.lane {
  position: absolute; box-sizing: border-box;
  background: rgba(0, 0, 0, .035); border: 1px solid rgba(0, 0, 0, .1); border-radius: 8px;
}
.lane.selected { border-color: #3b82f6; }
.lane-header {
  height: 36px; padding: 0 12px; line-height: 36px; font-weight: 600; color: #555;
  cursor: grab; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.lane-header input { font: inherit; color: inherit; width: 100%; padding: 0; border: 0; background: transparent; outline: none; }
.lane-resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(0, 0, 0, .2) 50%); border-bottom-right-radius: 8px;
}

.card {
  position: absolute; box-sizing: border-box; min-height: 40px; padding: 8px 10px; border-radius: 3px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .15), 0 2px 6px rgba(0, 0, 0, .06);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.card.selected { outline: 2px solid #3b82f6; outline-offset: 1px; }
.card .title { font-weight: 600; }
.card.editing .title, .card.editing .body { display: none; }
.card textarea {
  display: block; box-sizing: border-box; width: 100%; padding: 0; margin: 0; border: 0; outline: none;
  resize: none; overflow: hidden; background: transparent; font: inherit; color: inherit;
  user-select: text; -webkit-user-select: text;
}
.c1 { background: #fff3a8; }
.c2 { background: #ffc9d9; }
.c3 { background: #bfe3ff; }
.c4 { background: #c8f0c0; }
.c5 { background: #e2e2e2; }

#marquee { position: absolute; border: 1px solid #3b82f6; background: rgba(59, 130, 246, .1); pointer-events: none; }

#toolbar { position: fixed; left: 12px; bottom: 12px; display: flex; gap: 12px; align-items: center; font-size: 12px; color: #777; }
#toolbar button { font: inherit; padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
#toolbar button:disabled { cursor: default; opacity: .5; }
#status.error { color: #c0392b; font-weight: 600; }
```

`app/view.js`:

```js
class View {
  constructor(root, board) {
    this.root = root;
    this.board = board;
    this.world = root.querySelector("#world");
    this.lanesEl = root.querySelector("#lanes");
    this.cardsEl = root.querySelector("#cards");
    this.marqueeEl = root.querySelector("#marquee");
    this.statusEl = document.getElementById("status");
    this.els = new Map();
    this.selected = new Set();
    this.editing = null;
    this.editor = null;
  }

  render() {
    const { view, cards, lanes } = this.board.data;
    this.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    this.root.style.backgroundSize = `${GRID * view.zoom}px ${GRID * view.zoom}px`;
    this.root.style.backgroundPosition = `${view.x}px ${view.y}px`;
    const live = new Set();
    for (const lane of lanes) {
      live.add(lane.id);
      this.renderLane(lane);
    }
    for (const card of cards) {
      live.add(card.id);
      this.renderCard(card);
    }
    for (const [id, el] of this.els) {
      if (live.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.selected.delete(id);
    }
  }

  element(id, parent, html) {
    let el = this.els.get(id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = id;
      el.innerHTML = html;
      parent.append(el);
      this.els.set(id, el);
    }
    return el;
  }

  classes(base, id) {
    return base + (this.selected.has(id) ? " selected" : "") + (this.editing === id ? " editing" : "");
  }

  renderCard(c) {
    const el = this.element(c.id, this.cardsEl, '<div class="title"></div><div class="body"></div>');
    el.className = this.classes(`card c${c.color}`, c.id);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.width = `${c.w}px`;
    if (this.editing === c.id) return;
    const [title, ...body] = c.text.split("\n");
    el.querySelector(".title").textContent = title;
    el.querySelector(".body").textContent = body.join("\n");
  }

  renderLane(l) {
    const el = this.element(l.id, this.lanesEl, '<div class="lane-header"></div><div class="lane-resize"></div>');
    el.className = this.classes("lane", l.id);
    el.style.left = `${l.x}px`;
    el.style.top = `${l.y}px`;
    el.style.width = `${l.w}px`;
    el.style.height = `${l.h}px`;
    if (this.editing !== l.id) el.querySelector(".lane-header").textContent = l.title;
  }

  select(ids) {
    this.selected = new Set(ids);
    this.render();
  }

  toggle(id) {
    if (!this.selected.delete(id)) this.selected.add(id);
    this.render();
  }

  heightOf(id) {
    return this.els.get(id)?.offsetHeight ?? 0;
  }

  toWorld(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    const v = this.board.data.view;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }

  openCardEditor(id) {
    this.editing = id;
    const el = this.els.get(id);
    el.classList.add("editing");
    const ta = document.createElement("textarea");
    ta.value = this.board.card(id).text;
    el.append(ta);
    this.fit(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.editor = ta;
    return ta;
  }

  openLaneEditor(id) {
    this.editing = id;
    const header = this.els.get(id).querySelector(".lane-header");
    const input = document.createElement("input");
    input.value = this.board.lane(id).title;
    header.textContent = "";
    header.append(input);
    input.focus();
    input.select();
    this.editor = input;
    return input;
  }

  closeEditor() {
    this.editor?.remove();
    this.els.get(this.editing)?.classList.remove("editing");
    this.editor = null;
    this.editing = null;
  }

  fit(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  showMarquee(r) {
    Object.assign(this.marqueeEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    this.marqueeEl.hidden = false;
  }

  hideMarquee() {
    this.marqueeEl.hidden = true;
  }

  setStatus(text, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", isError);
  }
}
```

`app/store.js`:

```js
const SAVE_DELAY = 500;
const RETRY_DELAY = 5000;

class Store {
  constructor(board, view) {
    this.board = board;
    this.view = view;
    this.readOnly = location.protocol === "file:";
    this.timer = null;
    this.saving = false;
    this.dirty = false;
    this.stopped = false;
    view.setStatus(this.readOnly ? "read-only: run breezy.py to edit" : "saved");
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty || this.saving) e.preventDefault();
    });
  }

  schedule(delay = SAVE_DELAY) {
    if (this.readOnly || this.stopped) return;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (this.saving) return;
    this.saving = true;
    this.dirty = false;
    this.view.setStatus("saving…");
    let failed = false;
    try {
      const res = await fetch("/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.board.data),
      });
      if (res.status === 409) {
        this.stopped = true;
        this.view.setStatus("changed elsewhere — reload", true);
        return;
      }
      if (!res.ok) throw new Error(`server error ${res.status}`);
      this.board.data.rev = (await res.json()).rev;
      if (!this.dirty) this.view.setStatus("saved");
    } catch (err) {
      failed = true;
      const reason = err.message.startsWith("server error") ? err.message : "server unreachable";
      this.view.setStatus(`not saving: ${reason}`, true);
    } finally {
      this.saving = false;
      if (failed) this.schedule(RETRY_DELAY);
      else if (this.dirty) this.schedule();
    }
  }
}
```

`app/input.js`:

```js
class Input {
  constructor(view, board, store) {
    this.view = view;
    this.board = board;
    this.store = store;
    this.root = view.root;
    this.drag = null;
    this.pointer = { x: 0, y: 0 };
    this.root.addEventListener("pointerdown", (e) => this.down(e));
    this.root.addEventListener("pointermove", (e) => {
      this.pointer = view.toWorld(e.clientX, e.clientY);
    });
    this.root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", () => this.up());
    window.addEventListener("keydown", (e) => this.key(e));
  }

  get editable() {
    return !this.store.readOnly;
  }

  down(e) {
    if (e.button !== 0 || e.target.closest("textarea, input")) return;
    document.activeElement?.blur();
    this.view.select([]);
    const v = this.board.data.view;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      const v = this.board.data.view;
      v.x = d.vx + e.clientX - d.sx;
      v.y = d.vy + e.clientY - d.sy;
      this.board.changed();
    }
  }

  up() {
    this.drag = null;
  }

  wheel(e) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : 1;
    const v = this.board.data.view;
    if (e.ctrlKey || e.metaKey) {
      const r = this.root.getBoundingClientRect();
      Object.assign(v, zoomAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * scale * 0.01)));
    } else {
      v.x -= e.deltaX * scale;
      v.y -= e.deltaY * scale;
    }
    this.board.changed();
  }

  key(e) {
    if (e.target.closest?.("textarea, input")) return;
    if (e.key === "Escape") this.view.select([]);
  }
}
```

`app/main.js`:

```js
{
  const board = new Board(JSON.parse(document.getElementById("board-data").textContent));
  const view = new View(document.getElementById("board"), board);
  const store = new Store(board, view);
  board.onChange = () => {
    view.render();
    store.schedule();
  };
  new Input(view, board, store);
  document.getElementById("add-lane").disabled = store.readOnly;
  view.render();
}
```

- [ ] **Step 4: Run all tests and a syntax check**

Run: `python3 -m unittest discover --start-directory tests && node --test && for f in app/*.js; do node --check "$f" || exit 1; done`
Expected: `OK` (18 tests), `# fail 0`, no syntax errors.

- [ ] **Step 5: Check in the browser**

Create a seeded board and start the server:

```bash
mkdir -p "$SCRATCH/t3" && python3 - "$SCRATCH/t3/board.html" <<'EOF'
import sys, breezy
from pathlib import Path
data = breezy.empty_data()
data["cards"] = [{"id": "c1", "x": 40, "y": 60, "w": 200, "text": "Hello\nworld", "color": 1},
                 {"id": "c2", "x": 300, "y": 60, "w": 200, "text": "Second", "color": 3}]
data["lanes"] = [{"id": "l1", "x": 20, "y": 20, "w": 520, "h": 300, "title": "Ideas"}]
Path(sys.argv[1]).write_text(breezy.assemble(data))
EOF
python3 breezy.py "$SCRATCH/t3/board.html"
```

(`$SCRATCH` = the session scratchpad directory. Run the server in the background.)

Open `http://localhost:64570/` and confirm:
- the dot grid, an "Ideas" lane behind two cards: yellow "**Hello** / world" and blue "**Second**"; status "saved"
- dragging empty space pans; two-finger scroll pans; pinch or ⌘-scroll zooms around the cursor, stopping at 0.25 and 2
- after panning, the status shows "saving…" then "saved", and reloading keeps the pan position
- stop the server and pan: status "not saving: server unreachable" in red; restart the server: within 5 s status returns to "saved"
- with the server stopped and a pending change, closing the tab asks for confirmation
- open `board.html` directly from disk: board renders, status "read-only: run breezy.py to edit", "+ Lane" disabled

- [ ] **Step 6: Commit**

```bash
git add app tests/test_breezy.py
git commit --message "Render the board, save changes, pan and zoom

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```

---

### Task 4: Card interactions

**Files:**
- Modify: `app/input.js`

**Interfaces:**
- Consumes: `View` and `Board` methods listed in Tasks 2 and 3.
- Produces: `Input` methods `downOnCard(id, shift, p)`, `dblclick(e)`, `editCard(id, fresh)`; `move` dispatches on `drag.kind` `"pan" | "cards"`; `up` ends gestures via `dropNoopCheckpoint`. Task 5 adds kinds `"lane" | "resize" | "marquee"` to the same `down`, `move`, `up`.

- [ ] **Step 1: Register double-click in the constructor**

In `constructor`, after the `pointerdown` listener, add:

```js
    this.root.addEventListener("dblclick", (e) => this.dblclick(e));
```

- [ ] **Step 2: Replace `down`, `move`, `up` and `key`, and add the card methods**

Replace `down(e)`, `move(e)`, `up()` and `key(e)` with:

```js
  down(e) {
    if (e.button !== 0 || e.target.closest("textarea, input")) return;
    document.activeElement?.blur();
    const p = this.view.toWorld(e.clientX, e.clientY);
    const card = e.target.closest(".card");
    if (card) return this.downOnCard(card.dataset.id, e.shiftKey, p);
    this.view.select([]);
    const v = this.board.data.view;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  }

  downOnCard(id, shift, p) {
    if (shift) return this.view.toggle(id);
    if (!this.view.selected.has(id)) this.view.select([id]);
    if (!this.editable) return;
    const origins = [...this.view.selected]
      .map((s) => this.board.card(s))
      .filter(Boolean)
      .map((c) => ({ id: c.id, x: c.x, y: c.y }));
    this.board.checkpoint();
    this.drag = { kind: "cards", id, start: p, moved: false, origins };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      const v = this.board.data.view;
      v.x = d.vx + e.clientX - d.sx;
      v.y = d.vy + e.clientY - d.sy;
      return this.board.changed();
    }
    const p = this.view.toWorld(e.clientX, e.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    d.moved ||= Math.hypot(dx, dy) * this.board.data.view.zoom > 3;
    if (!d.moved) return;
    if (d.kind === "cards") this.board.moveCards(d.origins, dx, dy);
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === "pan") return;
    if (d.kind === "cards" && !d.moved) this.view.select([d.id]);
    this.board.dropNoopCheckpoint();
  }

  dblclick(e) {
    if (!this.editable || e.target.closest("textarea, input")) return;
    const card = e.target.closest(".card");
    if (card) return this.editCard(card.dataset.id, false);
    if (e.target.closest(".lane-header, .lane-resize")) return;
    const p = this.view.toWorld(e.clientX, e.clientY);
    const created = this.board.addCard(p.x, p.y);
    this.view.select([created.id]);
    this.editCard(created.id, true);
  }

  // fresh: the card was just created, so addCard already took the undo checkpoint
  editCard(id, fresh) {
    if (!fresh) this.board.checkpoint();
    const ta = this.view.openCardEditor(id);
    ta.addEventListener("input", () => {
      this.board.setText(id, ta.value);
      this.view.fit(ta);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) ta.blur();
    });
    ta.addEventListener("blur", () => {
      this.view.closeEditor();
      this.board.finishEdit(id);
    }, { once: true });
  }

  key(e) {
    if (e.target.closest?.("textarea, input")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!this.editable) return;
      if (e.shiftKey) this.board.redo();
      else this.board.undo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape") return this.view.select([]);
    if (!this.editable) return;
    if (/^[1-5]$/.test(e.key)) return this.board.setColor([...this.view.selected], Number(e.key));
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      this.board.remove([...this.view.selected]);
      this.view.select([]);
    }
  }
```

- [ ] **Step 3: Run tests and syntax check**

Run: `python3 -m unittest discover --start-directory tests && node --test && node --check app/input.js`
Expected: all pass.

- [ ] **Step 4: Check in the browser** (fresh empty board: `python3 breezy.py "$SCRATCH/t4/board.html"`)

- double-click empty space: a yellow card appears at the snapped position with a caret; type "Plan\nsteps" (Enter for a newline); Esc → "**Plan**" bold over "steps"
- double-click, type nothing, click elsewhere → no card remains; ⌘Z does not bring back an empty card
- double-click the card, change text, click away; ⌘Z restores the old text, ⇧⌘Z reapplies
- drag the card: it follows the pointer in 20 px steps; release; ⌘Z puts it back
- create 3 cards, ⇧-click two, drag one: both move; plain click on one selects only it
- select a card, press 3 → blue; ⌫ deletes it; ⌘Z restores it
- typing digits or ⌫ inside a card editor edits the text and does not recolour or delete
- reload: everything persists

- [ ] **Step 5: Commit**

```bash
git add app/input.js
git commit --message "Create, edit, move, colour and delete cards

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```

---

### Task 5: Lanes and rubber-band selection

**Files:**
- Modify: `app/input.js`

**Interfaces:**
- Consumes: `Board.addLane`, `moveLane`, `resizeLane`, `cardsInLane`, `cardsInRect`, `setLaneTitle`, `finishEdit`; `View.openLaneEditor`, `showMarquee`, `hideMarquee`; `LANE_W`, `LANE_H`.
- Produces: `Input` methods `downOnLane`, `downOnResize`, `editLane`, `addLane(x, y)`, `addLaneAtCentre()`.

- [ ] **Step 1: Register the toolbar button in the constructor**

At the end of `constructor`, add:

```js
    document.getElementById("add-lane").addEventListener("click", () => this.addLaneAtCentre());
```

- [ ] **Step 2: Replace `down`, `move`, `up` and `dblclick`, and add the lane methods**

Replace `down(e)`, `move(e)`, `up()` and `dblclick(e)` with:

```js
  down(e) {
    if (e.button !== 0 || e.target.closest("textarea, input")) return;
    document.activeElement?.blur();
    const p = this.view.toWorld(e.clientX, e.clientY);
    const card = e.target.closest(".card");
    const resize = e.target.closest(".lane-resize");
    const header = e.target.closest(".lane-header");
    if (card) return this.downOnCard(card.dataset.id, e.shiftKey, p);
    if (resize) return this.downOnResize(resize.parentElement.dataset.id, p);
    if (header) return this.downOnLane(header.parentElement.dataset.id, e.shiftKey, p);
    if (e.shiftKey) {
      this.drag = { kind: "marquee", start: p, base: [...this.view.selected] };
      return;
    }
    this.view.select([]);
    const v = this.board.data.view;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  }

  downOnLane(id, shift, p) {
    if (shift) return this.view.toggle(id);
    this.view.select([id]);
    if (!this.editable) return;
    const lane = this.board.lane(id);
    const cards = this.board
      .cardsInLane(id, (cid) => this.view.heightOf(cid))
      .map((c) => ({ id: c.id, x: c.x, y: c.y }));
    this.board.checkpoint();
    this.drag = { kind: "lane", start: p, moved: false, lane: { id, x: lane.x, y: lane.y }, cards };
  }

  downOnResize(id, p) {
    this.view.select([id]);
    if (!this.editable) return;
    const lane = this.board.lane(id);
    this.board.checkpoint();
    this.drag = { kind: "resize", id, start: p, moved: false, w: lane.w, h: lane.h };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      const v = this.board.data.view;
      v.x = d.vx + e.clientX - d.sx;
      v.y = d.vy + e.clientY - d.sy;
      return this.board.changed();
    }
    const p = this.view.toWorld(e.clientX, e.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.kind === "marquee") {
      const rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      this.view.showMarquee(rect);
      const hits = this.board.cardsInRect(rect, (id) => this.view.heightOf(id)).map((c) => c.id);
      return this.view.select([...d.base, ...hits]);
    }
    d.moved ||= Math.hypot(dx, dy) * this.board.data.view.zoom > 3;
    if (!d.moved) return;
    if (d.kind === "cards") this.board.moveCards(d.origins, dx, dy);
    else if (d.kind === "lane") this.board.moveLane(d.lane, d.cards, dx, dy);
    else if (d.kind === "resize") this.board.resizeLane(d.id, d.w + dx, d.h + dy);
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === "pan") return;
    if (d.kind === "marquee") return this.view.hideMarquee();
    if (d.kind === "cards" && !d.moved) this.view.select([d.id]);
    this.board.dropNoopCheckpoint();
  }

  dblclick(e) {
    if (!this.editable || e.target.closest("textarea, input")) return;
    const card = e.target.closest(".card");
    const header = e.target.closest(".lane-header");
    if (card) return this.editCard(card.dataset.id, false);
    if (header) return this.editLane(header.parentElement.dataset.id);
    if (e.target.closest(".lane-resize")) return;
    const p = this.view.toWorld(e.clientX, e.clientY);
    const created = this.board.addCard(p.x, p.y);
    this.view.select([created.id]);
    this.editCard(created.id, true);
  }

  editLane(id) {
    this.board.checkpoint();
    const input = this.view.openLaneEditor(id);
    input.addEventListener("input", () => this.board.setLaneTitle(id, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      this.view.closeEditor();
      this.board.finishEdit(id);
    }, { once: true });
  }

  addLane(x, y) {
    const lane = this.board.addLane(x, y);
    this.view.select([lane.id]);
  }

  addLaneAtCentre() {
    if (!this.editable) return;
    const r = this.root.getBoundingClientRect();
    const c = this.view.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    this.addLane(c.x - LANE_W / 2, c.y - LANE_H / 2);
  }
```

- [ ] **Step 3: Add the `L` shortcut to `key`**

In `key(e)`, directly after the line `if (!this.editable) return;`, add:

```js
    if (e.key === "l" || e.key === "L") return this.addLane(this.pointer.x, this.pointer.y);
```

- [ ] **Step 4: Run tests and syntax check**

Run: `python3 -m unittest discover --start-directory tests && node --test && node --check app/input.js`
Expected: all pass.

- [ ] **Step 5: Check in the browser** (fresh empty board: `python3 breezy.py "$SCRATCH/t5/board.html"`)

- hover empty space, press `L`: a 400 × 600 "Lane" appears at the cursor, selected; "+ Lane" adds one at the viewport centre
- double-click the lane header, type "Ideas", Enter → renamed; ⌘Z reverts the name in one step
- double-click inside the lane body → a new card, drawn above the lane
- put two cards in the lane and one outside; drag the header → the two move with it, snapped; the outside card stays
- drag the bottom-right corner → resizes in 20 px steps, never below 100 × 100
- select the lane, ⌫ → lane gone, its cards stay; ⌘Z restores the lane
- ⇧-drag on empty space → blue rectangle; cards it touches become selected; release hides the rectangle
- reload: lanes, titles and positions persist

- [ ] **Step 6: Commit**

```bash
git add app/input.js
git commit --message "Add lanes and rubber-band selection

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```

---

### Task 6: README and final pass

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# Breezy

A whiteboard for work thoughts: sticky-note cards and lanes on an infinite canvas, kept in one self-contained HTML file.

## Run

```bash
python3 breezy.py ~/Documents/board.html   # created if missing; --port to change 64570
```

Open http://localhost:64570/. Changes are written into the board file half a second after you make them. Earlier versions go to `backups/` beside it: at most one per 10 minutes, newest 50 kept. Opened straight from disk, the file shows the board read-only.

## Use

| Do | How |
|---|---|
| New card | double-click empty space |
| Edit card | double-click it; Esc or ⌘↩ to finish; first line is the title |
| Move | drag; ⇧-click or ⇧-drag on empty space to select several |
| Colour | `1`–`5` |
| Delete | ⌫ |
| New lane | `L` at the cursor, or **+ Lane** |
| Lane | drag the header to move it with its cards, the corner to resize, double-click the header to rename |
| Pan / zoom | drag empty space or scroll / pinch or ⌘-scroll |
| Undo / redo | ⌘Z / ⇧⌘Z |

## Develop

```bash
node --test
python3 -m unittest discover --start-directory tests
```
````

- [ ] **Step 2: Full run-through**

Run all tests (`python3 -m unittest discover --start-directory tests && node --test`), then walk through every browser check from Tasks 3–5 once more on one board, plus:
- two tabs on the same board: edit in tab A, then in tab B → tab B shows "changed elsewhere — reload" and the file keeps tab A's change
- a card whose text is `</script><b>x</b>` survives a reload unchanged
- `python3 breezy.py README.md` → exits with `breezy: README.md: no board data found`, README untouched

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit --message "Add README

Claude-Session: https://claude.ai/code/session_01FDrWaFUJr1s6KH5MQ4jEmg"
```
