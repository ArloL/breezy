// Three-way merge of one record, as BreezyKit's Merge: each field takes the side that changed it, the server's when
// both did; text or notes both sides changed differently, or changed on one side and deleted on the other, go into a
// copy card so that nothing typed is lost.

const TEXTS = ["text", "notes"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function equalRecords(a, b) {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
}

function copyOf(r) {
  const c = structuredClone(r);
  if (Array.isArray(r.pos) && r.pos.length === 2) c.pos = [r.pos[0] + 24, r.pos[1] + 24];
  return c;
}

export function mergeRecord(base, local, incoming) {
  base ??= {};
  if (incoming.deleted === true || local.deleted === true) {
    const survivor = incoming.deleted === true ? (local.deleted === true ? null : local) : incoming;
    const marker = incoming.deleted === true ? incoming : local;
    const changed = survivor && TEXTS.some((k) => !same(survivor[k], base[k]));
    return { record: marker, copy: changed ? copyOf(survivor) : null };
  }
  const record = {};
  let conflict = false;
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)])) {
    const b = base[k], l = local[k], i = incoming[k];
    let v;
    if (same(l, b)) v = i;
    else if (same(i, b) || same(i, l)) v = l;
    else {
      v = i;
      if (TEXTS.includes(k)) conflict = true;
    }
    if (v !== undefined) record[k] = v;
  }
  return { record, copy: conflict ? copyOf(local) : null };
}
