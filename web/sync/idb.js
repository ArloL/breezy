// The store's state in IndexedDB, under one key.

let opened = null;

function db() {
  opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("breezy", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return opened;
}

export async function loadState() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const q = d.transaction("state").objectStore("state").get("space");
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => reject(q.error);
  });
}

export async function saveState(state) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    t.objectStore("state").put(state, "space");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}
