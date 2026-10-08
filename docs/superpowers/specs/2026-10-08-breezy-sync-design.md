# Breezy sync — design

Two people share one set of boards across up to four devices: Macs running the [Mac app](2026-10-06-breezy-mac-design.md) and phones or browsers running the [web app](2026-10-07-breezy-touch-design.md). They mostly work at different times; changes arrive within seconds while a board is open. The server stores only encrypted records and can read none of them. It is one PHP file on MySQL, with no Apple developer account involved.

Boards stop being files. Each app keeps its boards in a local store and lists them; the `.breezy` format goes, with no import or export.

## Records

A space holds records, each with a random 128-bit id (22 characters, base64url, no kind prefix) and these fields:

| Kind | Fields |
|---|---|
| board | `title` |
| lane | `board`, `title`, `pos` (x, y), `size` (w, h) |
| card | `board`, `text`, `notes`, `color`, `pos` (x, y), `w`, `order` |

- A record's plaintext is JSON: `{"format": 1, "kind": "card", …fields}`. A deleted record is `{"format": 1, "kind": "card", "deleted": true}` and stays forever.
- `order` is a text sort key that replaces the array order of cards, so stacking order survives merges. Raising a card gives it a key after the highest; a new card gets one too. Keys are fractional indices: a key can always be made between two others.
- `pos` and `size` are single fields, so a merge never takes x from one move and y from another.
- Deleting a board deletes its lanes and cards. A record whose board is deleted or missing is not shown.
- The store drops a new record whose board is deleted, so leaving a board deleted elsewhere cannot leave orphan cards.
- Not synced: which card is turned, the camera, the selection, undo.

## Store

Each device keeps, per record:

- *base*: the plaintext last seen on the server and its server version (0 if never pushed);
- *current*: what the device shows.

A record whose current differs from its base is pending. The store also holds the space id, the secret, the server URL and the cursor: the highest version pulled.

A board on screen is a `Board` value, as now: `BoardModel` (Swift) and `web/model.js` keep editing it. Shortly after a change, and before merged changes are applied, the board is diffed against the last value the store saw, and only the fields that changed are written into the current records, so a local change never overwrites a field the other device changed. Cards come from the store sorted by `order`, then id; lanes by id.

## Sync

A cycle runs when a board opens, when the app comes back to the foreground, every 5 s while any Breezy window or the web app (board or board list) is visible, and 1 s after a local change.

1. **Pull** every record after the cursor, in pages of 500. Merge each into the store (below), then advance the cursor.
2. **Push** pending records, each with its base version. Accepted records take the returned version and their current becomes their base. For each refused record, merge the returned record into the store and push again; after three refusals in one cycle, back off.

Every response names the space's *epoch*: a random value it gets when created and a new one when its database is restored from a backup (null for a space the server lacks). Each record keeps the epoch it was written in; one from an earlier epoch comes marked `stale`, as the backup has it. A device takes the epoch when it has none. When the epoch differs from the one stored, the device resyncs. It forgets its versions and unreadable count and pulls from 0. A stale record it already has becomes that record's base while the device keeps its own contents, so whatever the device has beyond the backup is pushed, and refusals merge against the backup's copy. A fresh record, written since by a device that resynced first, merges as usual against the device's base. Records the server lacks are pushed with base 0, which recreates a lost space with a new epoch.

Merged changes are applied to the open `Board` and spring into place like any other change, without adding undo steps; while a drag or an edit is in progress they wait until it ends. The stacking rules then run on the board, but only for what this device shows: the Mac and the browser measure text differently, and pushing each other's layouts would go back and forth forever. Positions go to the server only from local edits.

### Merge

Three-way, field by field, with *base* (the old base), *local* (current) and *incoming* (the server's record, which becomes the new base):

| Case | Result |
|---|---|
| a field changed on one side only | that side's value |
| a field changed on both sides to the same value | that value |
| `text` or `notes` changed on both sides, differently | incoming's card; local's card, with its text, notes and colour, becomes a new card 24 pt right of and below it |
| any other field changed on both sides | incoming's value |
| one side deleted the record | deleted; if the other side changed `text` or `notes`, its version becomes a new card as above |

A record new to the device has no base and is taken as it arrives.

### Undo

An undo step keeps, per changed field, its value before and after. Undoing writes the before value to each field still holding its after value and leaves fields the other person changed since. Redo works the same way in reverse. Undo stays per device, in memory, 100 steps, as now.

## Server

`server/sync.php` on PHP 8 with PDO, and `server/schema.sql`:

```sql
CREATE TABLE spaces  (id BINARY(16) PRIMARY KEY, token_hash BINARY(32) NOT NULL, version BIGINT NOT NULL, epoch BINARY(16) NOT NULL);
CREATE TABLE records (space BINARY(16), id BINARY(16), version BIGINT NOT NULL, data MEDIUMBLOB NOT NULL,
                      epoch BINARY(16) NOT NULL, PRIMARY KEY (space, id), KEY (space, version));
```

Requests carry `Authorization: Bearer <token>`; the server compares SHA-256 of the token with `token_hash`.

| Request | Does |
|---|---|
| `GET sync.php?space=S&since=N` | `{records: [{id, version, blob, stale?}], cursor, epoch}`, ordered by version, at most 500; `epoch` is null for an unknown space; `stale: true` marks a record written in an earlier epoch |
| `POST sync.php?space=S` with `{writes: [{id, base, blob}]}` | in one transaction that locks the space row: each write whose stored version equals `base` (0: no stored record), or whose id the server has no record for whatever its base, so devices can refill a restored or lost database, gets the space's next version and its epoch; returns `{accepted: [{id, version}], refused: [{id, version, blob, stale?}], epoch}` |

- POST retries the whole transaction on a MySQL deadlock or duplicate-key race. Unexpected errors answer 500 `{"error":"server"}` without details.
- The first POST to an unknown space creates it with the token's hash and a random 16-byte epoch. Space ids are 128-bit random.
- After restoring the database from a backup, `UPDATE spaces SET epoch = RANDOM_BYTES(16);` marks every record stale and makes devices resync.
- Ids, blobs, tokens and epochs travel as base64url.
- Limits: a blob at most 64 KB, a request at most 1 MB. Otherwise 413.
- 401 for a wrong token, 400 for a malformed request.
- HTTPS only. CORS allows `https://arlol.github.io` and `http://localhost:58565`.
- Deploying is by hand: upload `sync.php`, run `schema.sql`, put the database credentials in `server/config.php`, which git ignores.

## Encryption

- A space secret is 32 random bytes. HKDF-SHA256 derives an AES-256-GCM key (info `breezy key`) and the token (info `breezy token`, 32 bytes).
- A blob is a 12-byte random nonce followed by the AES-GCM ciphertext and tag. The additional data is the space id followed by the record id, so a blob moved to another record or space fails to decrypt.
- WebCrypto and CryptoKit do both; neither app takes a dependency.
- The server sees record count, sizes, timing and random ids, not kinds or content.

## Joining

- **Start Syncing** creates a space with a new secret on a server URL you enter, and uploads every local record.
- **Share Invite** gives a link: `https://arlol.github.io/breezy/#join=<base64url of {server, space, secret} as JSON>`. The part after `#` never reaches a server. The Mac copies it; the web app opens the share sheet.
- **Join Space** takes a pasted link. On iOS an installed web app has its own storage, separate from Safari's, so opening the link in Safari would not join it; the link is pasted inside the app. Joining asks first, naming the server's host, when the device has boards of its own or the web app was opened from the link; then the space's boards replace the device's.
- Before syncing, a device works alone on its local boards.
- Anyone with the link or a copy of a device's store can join. Changing the secret or removing a person is out of scope; a new space and a new invite do it.

## Mac app

- The store is `~/Library/Application Support/Breezy/space.json`, mode 0600, written atomically off the main thread shortly after each change. The secret lives in it rather than the Keychain: the app is ad-hoc signed, and each new build would raise a Keychain prompt.
- `BoardDocument` stays an `NSDocument` without a file: one window per board, restored by board id. Autosave, Versions, Recent items and title-bar rename go.
- A **Boards** window lists boards by title, with New, Rename and Delete; double-clicking opens one. It opens at launch when no board window is restored.
- The app menu gains Start Syncing…, Join Space…, Share Invite and the sync status.
- The `local.breezy.board` type and its icon go. `BoardFormat` stays only for scripted checks: `-BreezyBoard <json>` loads a board into a store in a temporary folder.
- BreezyKit gains `Records` (Board ↔ records, diffing), `Merge`, `OrderKey`, `Store`, `SyncClient` (URLSession, behind a protocol for tests) and `SpaceCrypto`.

## Web app

- The store is IndexedDB. The app asks for persistent storage; if iOS clears it anyway, the invite goes too: the device joins again with the link and then gets everything back.
- It opens on a list of boards; a board's top bar gains a back button. The first launch on a device creates one board from the sample. `?stress` loads 500 cards into a board that is not stored.
- The ⋯ menu gains Start Syncing, Join Space, Share Invite and the sync status.
- New modules in `web/sync/`: `records.js`, `merge.js`, `order-key.js`, `store.js`, `client.js`, `crypto.js`.

## Status and errors

The status reads "Synced just now", "Offline — 3 changes waiting", "Can't reach server" or one of the cases below.

| Problem | Behaviour |
|---|---|
| network failure, timeout, 5xx | pending changes wait; retry after 5 s, doubling to 60 s |
| 401 | syncing stops; "Not in this space any more"; local boards stay; Join Space starts again |
| a record fails to decrypt or parse | skipped and counted ("2 unreadable changes"); the cursor moves on |
| a record's `format` is newer than the app | kept unapplied; "Update Breezy to see all changes"; unknown fields in a known format are kept and ignored |
| a record over 64 KB | not pushed; "Card too long to sync" until shortened |
| the Mac's store fails to write | the standard save-error alert |
| the web app's store fails to write | the database is reopened and the write tried once more; if that fails too, "Boards can’t be saved on this device" until a write succeeds |

## Testing

- **Shared fixtures**, in `BreezyKit/Tests/Fixtures/`, read by `swift test` and `node --test`: a table of merge cases (base, local, incoming → result) and an encryption vector with a fixed nonce. Swift and JavaScript must give the same results and read each other's blobs.
- **Unit tests** in both languages: Board ↔ records, diffing, order keys, undo after the other device changed fields.
- **Convergence:** four simulated devices make seeded random edits, go offline and back against an in-memory fake server, and must end with identical boards.
- **Server:** `server/test.sh` runs `sync.php` under `php -S` with a local MySQL and checks conditional writes, refusals, paging, auth, creation and limits.
- **By hand:** the Mac app and the web app, in the simulator and on the phone, in one space, each editing while the other is offline.

## Out of scope

History or restore beyond undo, changing the secret, removing a person, presence or live updates, automated server deployment, importing existing `.breezy` files.
