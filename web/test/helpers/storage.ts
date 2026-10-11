/** Storage in memory, as web/sync/idb.js keeps it; `failing` makes saves reject. */
export class MemoryStorage {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(structuredClone(entries)));
    this.failing = false;
  }

  async loadAll() {
    return structuredClone(Object.fromEntries(this.data));
  }

  async save(key, value) {
    if (this.failing) throw new Error("full");
    this.data.set(key, structuredClone(value));
  }

  async remove(key) {
    this.data.delete(key);
  }
}
