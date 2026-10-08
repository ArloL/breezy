// `mine`'s changes since `base`, made to `theirs` field by field, as BreezyKit's Board.rebase; where `theirs` changed a
// field too, `theirs` wins. Undo uses it so that a step back leaves changes from another device alone.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (b, m, t) => (same(t, b) ? m : t);

function item(b, m, t, merge) {
  if (b && m && t) return merge(b, m, t);
  if (b && !m && t) return same(t, b) ? null : t;
  if (b && !t) return null;
  if (!b && m && !t) return m;
  return t ?? null;
}

function card(b, m, t) {
  const c = { ...t };
  if (t.x === b.x && t.y === b.y) Object.assign(c, { x: m.x, y: m.y });
  for (const k of ["w", "text", "color"]) c[k] = pick(b[k], m[k], t[k]);
  const notes = pick(b.notes, m.notes, t.notes);
  if (notes === undefined) delete c.notes;
  else c.notes = notes;
  return c;
}

function lane(b, m, t) {
  const l = { ...t };
  if (t.x === b.x && t.y === b.y) Object.assign(l, { x: m.x, y: m.y });
  if (t.w === b.w && t.h === b.h) Object.assign(l, { w: m.w, h: m.h });
  l.title = pick(b.title, m.title, t.title);
  return l;
}

/** `keep` in `primary`'s order; the rest follow what came before them in `other`. */
function arrange(keep, primary, other) {
  const out = primary.filter((id) => keep.has(id));
  const placed = new Set(out);
  let last = -1;
  for (const id of other) {
    if (!keep.has(id)) continue;
    if (placed.has(id)) {
      last = Math.max(last, out.indexOf(id));
      continue;
    }
    out.splice(++last, 0, id);
    placed.add(id);
  }
  return out;
}

function merged(base, mine, theirs, merge) {
  const [b, m, t] = [base, mine, theirs].map((xs) => new Map(xs.map((x) => [x.id, x])));
  const out = new Map();
  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const x = item(b.get(id), m.get(id), t.get(id), merge);
    if (x) out.set(id, x);
  }
  return out;
}

export function rebase(base, mine, theirs) {
  const cards = merged(base.cards, mine.cards, theirs.cards, card);
  const ids = (xs) => xs.map((x) => x.id);
  const common = new Set(ids(mine.cards).filter((id) => ids(base.cards).includes(id)));
  const reordered = !same(ids(mine.cards).filter((id) => common.has(id)), ids(base.cards).filter((id) => common.has(id)));
  const cardOrder = reordered
    ? arrange(new Set(cards.keys()), ids(mine.cards), ids(theirs.cards))
    : arrange(new Set(cards.keys()), ids(theirs.cards), ids(mine.cards));
  const lanes = merged(base.lanes, mine.lanes, theirs.lanes, lane);
  const laneOrder = arrange(new Set(lanes.keys()), ids(theirs.lanes), ids(mine.lanes));
  return structuredClone({ cards: cardOrder.map((id) => cards.get(id)), lanes: laneOrder.map((id) => lanes.get(id)) });
}
