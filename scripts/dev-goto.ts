// Where the dev server (scripts/serve-web.ts) sends its pages when a replay asks (scripts/replay.ts).

/** The path and query of a page of the dev server's own to send pages to, or null. Only a request no web page can make
 * is heard: one with the replay header, which a browser would ask leave for first, and no Origin. A path is taken as a
 * browser takes it, so one it reads as another site, such as "/\t/evil.example", is refused. */
export function gotoTarget(to: string, headers: Record<string, string | string[] | undefined>): string | null {
  if (headers["x-breezy-replay"] !== "1" || headers.origin !== undefined) return null;
  if (!to.startsWith("/")) return null;
  const u = new URL(to, "http://dev.invalid");
  return u.origin === "http://dev.invalid" ? u.pathname + u.search : null;
}
