// Who holds what in a space, and who has to go; plain functions, so that they test without Cloudflare. A connection is
// { id, authed, opened, last, holds }, times in ms.

export const HOLD_TIMEOUT_MS = 10_000;
export const AUTH_TIMEOUT_MS = 5_000;
export const MAX_MESSAGE = 65_536;

/** Of `ids`, those a connection other than `id` holds. */
export function conflicts(conns, id, ids) {
  const taken = new Set(conns.filter((c) => c.id !== id).flatMap((c) => c.holds));
  return ids.filter((x) => taken.has(x));
}

/** `{connection id: ids}` for every connection holding something. */
export function holdsOf(conns) {
  return Object.fromEntries(conns.filter((c) => c.holds.length).map((c) => [c.id, c.holds]));
}

/** Connections whose holds lapse at `now`: silent for longer than the timeout. */
export const lapsed = (conns, now) => conns.filter((c) => c.holds.length && now - c.last > HOLD_TIMEOUT_MS);

/** Connections that have not authenticated in time. */
export const unauthenticated = (conns, now) => conns.filter((c) => !c.authed && now - c.opened > AUTH_TIMEOUT_MS);

export const validIDs = (ids) =>
  Array.isArray(ids) && ids.length <= 1000 && ids.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{22}$/.test(x));
