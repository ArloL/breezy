// The store's state in IndexedDB, under one key.

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

export function loadState() {
  return attempt((d) => new Promise((resolve, reject) => {
    const q = d.transaction("state").objectStore("state").get("space");
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => reject(q.error);
  }));
}

function put(d, state) {
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    t.objectStore("state").put(state, "space");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

/** Saves `state`, trying once more on a reopened database. */
export async function saveState(state) {
  try {
    return await attempt((d) => put(d, state));
  } catch {
    return attempt((d) => put(d, state));
  }
}
