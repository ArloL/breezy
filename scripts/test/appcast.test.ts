// The update feed as generate_appcast writes it, signed so that the app it updates accepts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { appcast, edKey, plistStrings, publicEdKey } from "../appcast.ts";

setTimeout(() => process.exit(1), 10_000).unref();

// RFC 8032's first Ed25519 test vector
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64");
const PUBLIC = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64");
const EMPTY_SIGNED = Buffer.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "hex").toString("base64");

const info = { CFBundleName: "Breezy", CFBundleVersion: "2611.0.134", CFBundleShortVersionString: "2611.0.134", LSMinimumSystemVersion: "15.0", SUPublicEDKey: PUBLIC };
const url = "https://github.com/ArloL/breezy/releases/download/v2611.0.134/breezy-macos.zip";

test("a Sparkle key signs as Ed25519 does", () => {
  const key = edKey(SEED);
  assert.equal(publicEdKey(key), PUBLIC);
  assert.match(appcast({ info, archive: Buffer.alloc(0), url, key }), new RegExp(`sparkle:edSignature="${EMPTY_SIGNED.replace(/[+/]/g, "\\$&")}"`));
});

test("the feed is generate_appcast's, its archive's signature one the app's key verifies", () => {
  const archive = Buffer.from("an archive"), key = edKey(SEED);
  const xml = appcast({ info, archive, url, key, now: new Date(Date.UTC(2026, 10, 6, 10, 28, 21)) });
  const signature = /sparkle:edSignature="([^"]+)"/.exec(xml)![1]!;
  assert.equal(xml.replace(signature, "SIG"), `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Breezy</title>
        <item>
            <title>2611.0.134</title>
            <pubDate>Fri, 06 Nov 2026 10:28:21 +0000</pubDate>
            <sparkle:version>2611.0.134</sparkle:version>
            <sparkle:shortVersionString>2611.0.134</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
            <enclosure url="${url}" length="10" type="application/octet-stream" sparkle:edSignature="SIG"/>
        </item>
    </channel>
</rss>
`);
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBLIC, "base64")]), format: "der", type: "spki" });
  assert.equal(verify(null, archive, pub, Buffer.from(signature, "base64")), true);
});

test("a key not the app's, or not a seed, signs nothing", () => {
  assert.throws(() => appcast({ info: { ...info, SUPublicEDKey: "MQp6FNCCHOb2mPuFpT8eF4xdSooNG5WHq0n9hwVVOQE=" }, archive: Buffer.alloc(1), url, key: edKey(SEED) }), /not the app's/);
  assert.throws(() => edKey(Buffer.alloc(96).toString("base64")), /96 bytes, not a 32-byte seed/);
});

test("an Info.plist's strings are read, and a binary one is refused", () => {
  assert.deepEqual(plistStrings(`<?xml version="1.0"?>\n<plist><dict>\n\t<key>CFBundleName</key>\n\t<string>A &amp; B</string>\n\t<key>LSUIElement</key>\n\t<true/>\n</dict></plist>`), { CFBundleName: "A & B" });
  assert.throws(() => plistStrings("bplist00"), /not XML/);
});
