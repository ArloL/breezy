import type { Store } from "../../sync/store.ts";

export const settle = (s: Store, version = 1) => { for (const p of s.pending()) s.accepted(p.id, version, p.record); };
