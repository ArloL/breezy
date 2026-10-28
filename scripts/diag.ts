#!/usr/bin/env node
// What the owner's and partner's devices sent of their recordings (server/diag.php), read with the space's own token
// from an invite link given at run time, which is kept nowhere:
//   BREEZY_INVITE='https://…#join=…' node scripts/diag.ts            lists them, newest first
//   BREEZY_INVITE='https://…#join=…' node scripts/diag.ts ID…        saves each as build/diag/ID.json, and drawn as .html
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInvite, SpaceKeys } from "../web/sync/crypto.ts";
import { decode, encode } from "../web/sync/base64.ts";
import { diagUrl, type Target } from "../web/diag.ts";
import { page } from "./wireframe.ts";
import type { Recording } from "../web/flight.ts";

/** The space an invite link in `text` names, with the token its devices sync with. */
export async function targetOf(text: string): Promise<Target> {
  const invite = parseInvite(text);
  if (!invite) throw new Error("no invite link in BREEZY_INVITE");
  const keys = await SpaceKeys.create(decode(invite.space)!, decode(invite.secret)!);
  return { server: invite.server, space: invite.space, token: encode(keys.token) };
}

async function get(t: Target, query: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(diagUrl(t.server));
  for (const [k, v] of Object.entries({ space: t.space, ...query })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url.pathname}${query.id ? ` ${query.id}` : ""}: ${res.status}`);
  return res.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t = await targetOf(process.env.BREEZY_INVITE ?? "");
  const ids = process.argv.slice(2);
  if (!ids.length) {
    const { recordings } = await get(t) as { recordings: { id: string; at: number; why: string; size: number }[] };
    for (const r of recordings) console.log(`${r.id}  ${new Date(r.at * 1000).toISOString()}  ${r.why.padEnd(5)}  ${r.size} bytes`);
    if (!recordings.length) console.log("none");
  }
  const dir = join(fileURLToPath(new URL("..", import.meta.url)), "build", "diag");
  for (const id of ids) {
    mkdirSync(dir, { recursive: true });
    const r = await get(t, { id }) as Recording;
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(r)}\n`);
    writeFileSync(join(dir, `${id}.html`), page(id, r));
    console.log(join(dir, `${id}.json`));
  }
}
