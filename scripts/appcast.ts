#!/usr/bin/env node
// The Mac app's update feed for one release, as Sparkle's generate_appcast writes it, on any runner: GitHub's macOS
// runners went short, and the appcast job, asking for one more after the build, lost its runner 5 times of 10 lost.
//   node scripts/appcast.ts ZIP URL-PREFIX < KEY > appcast.xml
// KEY is Sparkle's private EdDSA key, the base64 of its 32-byte seed.
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** The top level strings of an XML property list. */
export function plistStrings(xml: string): Record<string, string> {
  if (!xml.startsWith("<?xml")) throw new Error("Info.plist is not XML");
  const out: Record<string, string> = {};
  for (const [, k, v] of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[k!] = unescape(v!);
  return out;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Sparkle's private key: the base64 of a 32-byte seed. The 96-byte form of keys made before Sparkle 2 holds the seed
 * only hashed, which Node cannot sign with. */
export function edKey(base64: string): KeyObject {
  const seed = Buffer.from(base64.trim(), "base64");
  if (seed.length !== 32) throw new Error(`the private EdDSA key is ${seed.length} bytes, not a 32-byte seed`);
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
}

/** Sparkle's form of `key`'s public key: the base64 of its 32 bytes, as SUPublicEDKey holds it. */
export const publicEdKey = (key: KeyObject) => (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");

/** RFC 822, as generate_appcast dates an item. */
function rfc822(d: Date): string {
  const [day, , mon] = d.toUTCString().split(" ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day} ${p(d.getUTCDate())} ${mon} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** The feed of the one release `archive` holds, its app's Info.plist `info`, its download at `url`. */
export function appcast({ info, archive, url, key, now = new Date() }: { info: Record<string, string>; archive: Buffer; url: string; key: KeyObject; now?: Date }): string {
  const need = (k: string) => info[k] ?? (() => { throw new Error(`Info.plist has no ${k}`); })();
  // an app checks its updates against the key it was built with: a feed signed by another installs nowhere
  if (publicEdKey(key) !== need("SUPublicEDKey")) throw new Error(`the private EdDSA key is not the app's: its public key is ${publicEdKey(key)}, the app's SUPublicEDKey ${need("SUPublicEDKey")}`);
  const version = need("CFBundleVersion"), short = need("CFBundleShortVersionString");
  return `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>${escape(need("CFBundleName"))}</title>
        <item>
            <title>${escape(short)}</title>
            <pubDate>${rfc822(now)}</pubDate>
            <sparkle:version>${escape(version)}</sparkle:version>
            <sparkle:shortVersionString>${escape(short)}</sparkle:shortVersionString>
${info.LSMinimumSystemVersion ? `            <sparkle:minimumSystemVersion>${escape(info.LSMinimumSystemVersion)}</sparkle:minimumSystemVersion>\n` : ""}            <enclosure url="${escape(url)}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${sign(null, archive, key).toString("base64")}"/>
        </item>
    </channel>
</rss>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [zip, prefix] = process.argv.slice(2);
  if (!zip || !prefix) throw new Error("usage: node scripts/appcast.ts ZIP URL-PREFIX < KEY");
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", timeout: 30_000 }).split("\n");
  const plist = listing.find((p) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(p));
  if (!plist) throw new Error(`no app's Info.plist in ${zip}`);
  const info = plistStrings(execFileSync("unzip", ["-p", zip, plist], { encoding: "utf8", timeout: 30_000 }));
  process.stdout.write(appcast({ info, archive: readFileSync(zip), url: prefix + basename(zip), key: edKey(readFileSync(0, "utf8")) }));
}
