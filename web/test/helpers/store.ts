export const settle = (s, version = 1) => { for (const p of s.pending()) s.accepted(p.id, version, p.record); };
