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



class RealAppTest(unittest.TestCase):
    def test_real_app_assembles(self):
        page = breezy.assemble(breezy.empty_data())
        self.assertEqual(breezy.extract(page), breezy.empty_data())
        for name in breezy.JS_ORDER:
            self.assertIn((breezy.APP / name).read_text(encoding="utf-8"), page)
        self.assertIn((breezy.APP / "board.css").read_text(encoding="utf-8"), page)

if __name__ == "__main__":
    unittest.main()
