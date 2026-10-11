/** Storage in memory, as web/sync/idb.ts keeps it; `failing` makes saves reject. */
export class MemoryStorage {
  data: Map<string, unknown>;
  failing: boolean;

  constructor(entries: Record<string, unknown> = {}) {
    this.data = new Map(Object.entries(structuredClone(entries)));
    this.failing = false;
  }

  async loadAll() {
    return structuredClone(Object.fromEntries(this.data));
  }

  async save(key: string, value: unknown) {
    if (this.failing) throw new Error("full");
    this.data.set(key, structuredClone(value));
  }

  async remove(key: string) {
    this.data.delete(key);
  }
}
