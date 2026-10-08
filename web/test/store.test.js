import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, withFreshIDs } from "../sync/store.js";
import { deletedRecord } from "../sync/records.js";
import { settle } from "./helpers/store.js";

const card = (id, text = "t") => ({ id, x: 0, y: 0, w: 240, text, color: 1 });

test("a new board waits to be pushed", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  assert.deepEqual(s.boards(), [{ id, title: "Plans" }]);
  assert.deepEqual(s.board(id), { cards: [card("c")], lanes: [] });
  assert.deepEqual(s.pending().map((p) => p.id).sort(), [id, "c"].sort());
});

test("accepted records stop waiting unless changed since", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  const sent = s.pending();
  s.apply({ c: { fields: { color: 2 } } });
  for (const p of sent) s.accepted(p.id, 1, p.record);
  assert.deepEqual(s.pending().map((p) => p.id), ["c"]);
});

test("edits and merges combine field by field", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c", "x")], lanes: [] });
  settle(s);
  s.apply({ c: { fields: { color: 3 } } });
  const heard = [];
  s.onChange = (boards, remote) => heard.push([[...boards], remote]);
  s.merge([{ id: "c", version: 2, record: { ...s.state.records.c.base, text: "theirs" } }]);
  assert.equal(s.board(id).cards[0].color, 3);
  assert.equal(s.board(id).cards[0].text, "theirs");
  assert.deepEqual(heard, [[[id], true]]);
});

test("an older version is ignored", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c", "now")], lanes: [] });
  settle(s, 5);
  s.merge([{ id: "c", version: 4, record: { ...s.state.records.c.current, text: "old" } }]);
  assert.equal(s.state.records.c.current.text, "now");
});

test("a text conflict adds a copy card", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c", "x")], lanes: [] });
  settle(s);
  s.apply({ c: { fields: { text: "mine" } } });
  s.merge([{ id: "c", version: 2, record: { ...s.state.records.c.base, text: "theirs" } }]);
  assert.deepEqual(s.board(id).cards.map((c) => c.text).sort(), ["mine", "theirs"]);
});

test("edits to a deleted record are dropped", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  settle(s);
  s.merge([{ id: "c", version: 2, record: deletedRecord("card") }]);
  s.apply({ c: { fields: { color: 3 } } });
  assert.deepEqual(s.board(id).cards, []);
});

test("a new record on a deleted board is dropped", () => {
  const s = new Store();
  const id = s.createBoard("Plans");
  s.deleteBoard(id);
  let heard = 0;
  s.onChange = () => heard++;
  s.apply({ c: { fields: { kind: "card", board: id, text: "t" } } });
  assert.equal(s.state.records.c, undefined);
  assert.equal(heard, 0);
});

test("deleting a board deletes what is on it", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  s.deleteBoard(id);
  assert.deepEqual(s.boards(), []);
  assert.equal(s.title(id), null);
  assert.equal(s.state.records.c.current.deleted, true);
});

test("joining replaces the boards here", () => {
  const s = new Store();
  s.createBoard("Mine");
  s.join({ server: "https://example.com/sync.php", space: "QEFCQ0RFRkdISUpLTE1OTw", secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" });
  assert.deepEqual(s.boards(), []);
  assert.ok(s.syncing);
});

test("starting to sync pushes everything", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  settle(s);
  const invite = s.startSyncing("https://example.com/sync.php");
  assert.deepEqual(s.invite, invite);
  assert.ok(s.pending().length === 2 && s.pending().every((p) => p.base === 0));
});

test("fresh ids keep the board otherwise", () => {
  const b = withFreshIDs({ cards: [card("c")], lanes: [{ id: "l", x: 0, y: 0, w: 480, h: 720, title: "L" }] });
  assert.equal(b.cards[0].id.length, 22);
  assert.deepEqual({ ...b.cards[0], id: "c" }, card("c"));
});
