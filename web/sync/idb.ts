// The groups' states in IndexedDB, a key each.

let opened: Promise<IDBDatabase> | null = null, connection: IDBDatabase | null = null;

/** The open database; reopened after WebKit drops the connection, as iOS may while the app is suspended. */
function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
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

function forget(d: IDBDatabase): void {
  d.close();
  if (connection === d) connection = opened = null;
}

/** `request` in a transaction of the database; a failure lets the next call reopen it. */
async function attempt<T>(request: (d: IDBDatabase) => Promise<T>): Promise<T> {
  const d = await db();
  try {
    return await request(d);
  } catch (error) {
    forget(d);
    throw error;
  }
}

/** Every key's value: `local`, `space:<id>`, `server`, and `space` from before spaces. */
export function loadAll(): Promise<{ [key: string]: unknown }> {
  return attempt((d) => new Promise((resolve, reject) => {
    const out: { [key: string]: unknown } = {};
    const q = d.transaction("state").objectStore("state").openCursor();
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return resolve(out);
      out[c.key as string] = c.value;
      c.continue();
    };
    q.onerror = () => reject(q.error);
  }));
}

function change(d: IDBDatabase, apply: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    apply(t.objectStore("state"));
    // now, not after this task: Safari on iOS freezes a page hidden into its back-forward cache before then, and a
    // transaction never committed keeps every other page of the site from reading the store
    t.commit();
    t.oncomplete = () => resolve();
    // Safari on iOS fails one the page froze before with no error
    t.onerror = () => reject(t.error ?? new Error("transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

/** Saves `value` under `key`, trying once more on a reopened database. */
export async function saveState(key: string, value: unknown): Promise<void> {
  try {
    return await attempt((d) => change(d, (s) => s.put(value, key)));
  } catch {
    return attempt((d) => change(d, (s) => s.put(value, key)));
  }
}

export function removeState(key: string): Promise<void> {
  return attempt((d) => change(d, (s) => s.delete(key)));
}

export const storage = { loadAll, save: saveState, remove: removeState };
