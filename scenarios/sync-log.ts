// What a case's timeline says of each request to the servers and its answer: a push's writes, a report's why.
import { inflateRawSync } from "node:zlib";

const id = (r: { id: string }) => r.id.slice(0, 8);

/** Whether `url` is the app's report of its recording (web/diag.ts), sent beside its syncs. */
export const isReport = (url: string) => new URL(url).pathname.endsWith("/diag.php");

/** The note of a request to the servers carrying `body`. */
export function sentNote(url: string, body: Buffer, encoding?: string): string {
  const what = isReport(url) ? "report" : "push";
  try {
    const j = JSON.parse((encoding === "deflate" ? inflateRawSync(body) : body).toString());
    if (what === "report") return `report ${j.why}, ${j.recording.entries.length} entries`;
    return `push since ${j.since} epoch ${j.epoch} writes ${j.writes.map((w: { id: string; base: number }) => `${id(w)}@${w.base}`).join(" ")}`;
  } catch (e) {
    return `${what}, its body unread: ${e}`;
  }
}

/** The note of a sync's answer, `j` its body. */
export function answerNote(status: number, j: { accepted?: { id: string; version: number }[]; refused?: { id: string; version: number }[]; records?: { id: string; version: number }[]; cursor?: unknown; epoch?: unknown }): string {
  const list = (rs?: { id: string; version: number }[]) => (rs ?? []).map((r) => `${id(r)}@${r.version}`).join(" ");
  return `  ${status} accepted ${list(j.accepted)} refused ${list(j.refused)} records ${list(j.records)} cursor ${j.cursor} epoch ${j.epoch}`;
}
