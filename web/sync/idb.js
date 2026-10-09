// The groups' states in IndexedDB, a key each.

let opened = null, connection = null;

/** The open database; reopened after WebKit drops the connection, as iOS may while the app is suspended. */
function db() {
  opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("breezy", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = d.onversionchange = () => forget(d);
      connection = d;
      resolve(d);
    };
    r.onerror = () => reject(r.error);
  }).catch((error) => {
    opened = null;
    throw error;
  });
  return opened;
}

function forget(d) {
  d.close();
  if (connection === d) connection = opened = null;
}

/** `request` in a transaction of the database; a failure lets the next call reopen it. */
async function attempt(request) {
  const d = await db();
  try {
    return await request(d);
  } catch (error) {
    forget(d);
    throw error;
  }
}

/** Every key's value: `local`, `space:<id>`, `server`, and `space` from before spaces. */
export function loadAll() {
  return attempt((d) => new Promise((resolve, reject) => {
    const out = {};
    const q = d.transaction("state").objectStore("state").openCursor();
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return resolve(out);
      out[c.key] = c.value;
      c.continue();
    };
    q.onerror = () => reject(q.error);
  }));
}

function change(d, apply) {
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    apply(t.objectStore("state"));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

/** Saves `value` under `key`, trying once more on a reopened database. */
export async function saveState(key, value) {
  try {
    return await attempt((d) => change(d, (s) => s.put(value, key)));
  } catch {
    return attempt((d) => change(d, (s) => s.put(value, key)));
  }
}

export function removeState(key) {
  return attempt((d) => change(d, (s) => s.delete(key)));
}

export const storage = { loadAll, save: saveState, remove: removeState };
