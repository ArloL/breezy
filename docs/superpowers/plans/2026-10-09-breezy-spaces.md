# Breezy spaces — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A device joins any number of named spaces, each shared with different people, keeps boards of its own that never sync, and moves boards between them.

**Architecture:** Each group of boards ("On this device", and each joined space) is today's `Store` with its own `SyncEngine` and its own file or IndexedDB key. A new `Spaces` container, written twice (BreezyKit and `web/sync/spaces.js`), loads, migrates, saves, joins, leaves and moves boards between groups. A space's name is an ordinary encrypted record whose id is the space id. The server and record format do not change.

**Tech Stack:** Swift 6 toolchain in Swift 5 mode, swift-testing, AppKit; plain ES modules with `node:test`, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-10-09-breezy-spaces-design.md` (extends `docs/superpowers/specs/2026-10-08-breezy-sync-design.md`)

## Global Constraints

- Server, encryption and record `format` (1) stay unchanged. The name record is `{"format": 1, "kind": "space", "name": "…"}` with the space id as its record id.
- Fixed strings: `On this device`, `Shared Space` (a space without a name record), `New Space`, `Join Space`, `Rename Space`, `Share Invite`, `Leave Space`, `Move to`.
- Leave asks "Leave “Name”?" with "Its boards are removed from this device. Others in the space keep them." Move out of a space asks with "It is removed from “Name” on every device." Deleting a board in a space says "It is deleted on every device in “Name”."
- Mac files: `<store dir>/Spaces/local.json` and `<store dir>/Spaces/<space id>.json`, mode 0600, atomic. Last server in `UserDefaults` key `BreezyLastServer`. Web IndexedDB keys: `local`, `space:<space id>`, `server`.
- Groups are ordered On this device first, then spaces by name, then by space id. On this device is hidden when it is empty and the device is in a space.
- BreezyKit depends on Apple frameworks only. The web app takes no dependency and has no build step.
- Match the surrounding code: two-space indents, doc comments on types and non-obvious functions, few other comments. Commit messages are one imperative line, ending with the `Claude-Session:` trailer the session supplies.

## Review Focus

1. **Leaving a space while a save is still scheduled.** The space must not come back on the next launch. Pinned by `leavingRemovesTheFileForGood` (Task 3) and `leaving removes the space's key for good` (Task 4).
2. **A Move whose copy cannot be written** (disk full, store unwritable). The board must stay in its source group. Pinned by `aMoveThatCannotBeWrittenLeavesTheBoardWhereItWas` (Task 3) and `a move whose copy can't be saved leaves the board where it was` (Task 4).
3. **Pasting the same invite twice.** The device gets one group, not two copies of the space. Pinned by `joiningASpaceAlreadyJoinedGivesItsGroup` (Task 3) and its twin (Task 4).
4. **A name set on another device.** It arrives through a merge and must be reported, so lists and window titles update. Pinned by `aMergedNameIsReported` (Task 1) and `a merged name is reported` (Task 2).
5. **A launch after a migration was interrupted** (the new file was written, the old one not yet removed). It must run again without duplicating or losing anything. Pinned by `anInterruptedMigrationRunsAgain` (Task 3) and its twin (Task 4).

---

## File map

| File | Change |
|---|---|
| `BreezyKit/Sources/BreezyKit/Record.swift` | `Records.space(name:)` |
| `BreezyKit/Sources/BreezyKit/SpaceKeys.swift` | `Invite.name` |
| `BreezyKit/Sources/BreezyKit/Store.swift` | `SpaceState.invitedName`, `Store.name`, `rename`, `invite`; merge reports the name record; `StoreFile.saveNow`, `remove` |
| `BreezyKit/Sources/BreezyKit/Spaces.swift` | new: the container |
| `BreezyKit/Tests/BreezyKitTests/SpacesTests.swift` | new |
| `BreezyKit/Tests/Fixtures/crypto.json` | `namedInvite` |
| `web/sync/records.js`, `web/sync/store.js`, `web/sync/crypto.js` | as the Swift twins |
| `web/sync/idb.js` | keyed storage: `loadAll`, `saveState(key, value)`, `removeState`, `storage` |
| `web/sync/spaces.js` | new: the container |
| `web/test/spaces.test.js`, `web/test/helpers/storage.js` | new |
| `Breezy/Library/Library.swift`, `BoardsWindowController.swift`, `SyncMenu.swift` | groups instead of one store; source list |
| `Breezy/App/AppDelegate.swift`, `MainMenu.swift` | New/Join/Rename/Share/Leave Space, Move |
| `Breezy/Document/BoardDocument.swift` | title names the space |
| `Breezy/Support/DebugLaunch.swift`, `SelfTest.swift`, `BreezyUITests/BreezyUITests.swift` | `Spaces/local.json` |
| `web/index.html`, `web/style.css`, `web/sheet.js`, `web/ui.js`, `web/library.js` | grouped list, space menu, choice sheet |
| `README.md` | Sync section |

---

### Task 1: Name records and named invites in BreezyKit

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Record.swift` (after `Records.board(title:)`, line ~59)
- Modify: `BreezyKit/Sources/BreezyKit/SpaceKeys.swift` (`Invite`)
- Modify: `BreezyKit/Sources/BreezyKit/Store.swift` (`SpaceState`, `Store`)
- Modify: `BreezyKit/Tests/Fixtures/crypto.json`
- Test: `BreezyKit/Tests/BreezyKitTests/StoreTests.swift`, `BreezyKit/Tests/BreezyKitTests/CryptoTests.swift`

**Interfaces:**
- Produces: `Records.space(name: String) -> Record`; `Invite.name: String?` and `Invite(server:space:secret:name: String? = nil)`; `SpaceState.invitedName: String?`; `Store.name: String?`; `Store.rename(_ name: String)`; `Store.invite: Invite?` (with `name`). `Store.merge` reports the space id among the changed boards when the name record changes.

- [ ] **Step 1: Add the shared fixture**

In `BreezyKit/Tests/Fixtures/crypto.json`, add after `"invite"` (it is the same space with `"name": "Home & Work"`, keys sorted):

```json
  "namedInvite": "https://breezy.k5d.de/#join=eyJuYW1lIjoiSG9tZSAmIFdvcmsiLCJzZWNyZXQiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4Iiwic2VydmVyIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9icmVlenkvc3luYy5waHAiLCJzcGFjZSI6IlFFRkNRMFJGUmtkSVNVcExURTFPVHcifQ"
```

(Put a comma after the `invite` line.)

- [ ] **Step 2: Write the failing tests**

In `CryptoTests.swift`, add `namedInvite` to `Vector`:

```swift
private struct Vector: Decodable {
  var secret, space, id, nonce, plaintext, token, tokenHash, blob, server, invite, namedInvite: String
}
```

and add:

```swift
@Test func anInviteMayNameItsSpace() throws {
  let v = try vector()
  let named = Invite(server: v.server, space: v.space, secret: v.secret, name: "Home & Work")
  #expect(named.link == v.namedInvite)
  #expect(Invite(link: v.namedInvite) == named)
  #expect(Invite(link: v.invite)?.name == nil)
}
```

In `StoreTests.swift` add:

```swift
@Test func aSpaceIsNamedByItsRecordElseItsInvite() {
  let s = Store()
  #expect(s.name == nil)
  let invite = Invite(server: "https://example.com/sync.php", space: newID(), secret: Base64URL.encode(randomBytes(32)), name: "Ours")
  s.join(invite)
  #expect(s.name == "Ours")
  #expect(s.pending.isEmpty)
  s.rename("Home")
  #expect(s.name == "Home")
  #expect(s.invite?.name == "Home")
  #expect(s.boards.isEmpty)
  #expect(s.pending.map(\.id) == [invite.space])
  #expect(s.pending[0].record == Records.space(name: "Home"))
}

@Test func aMergedNameIsReported() {
  let s = Store()
  s.startSyncing(server: "https://example.com/sync.php")
  let space = s.state.space!
  var heard: Set<String> = []
  s.onChange = { boards, _ in heard = boards }
  s.merge([Incoming(id: space, version: 1, record: Records.space(name: "Work"))])
  #expect(s.name == "Work")
  #expect(heard == [space])
}

@Test func aStoreNotSyncingHasNoNameToChange() {
  let s = Store()
  s.rename("Home")
  #expect(s.name == nil)
  #expect(s.state.records.isEmpty)
}
```

- [ ] **Step 3: Run them and see them fail**

Run: `swift test --package-path BreezyKit --filter 'Name|named'`
Expected: compile errors: `extra argument 'name' in call`, `value of type 'Store' has no member 'name'`.

- [ ] **Step 4: Implement**

`Record.swift`, in `enum Records` after `board(title:)`:

```swift
  /// A space's name, kept in the record whose id is the space's.
  public static func space(name: String) -> Record {
    Record(["format": .number(Double(Record.format)), "kind": .string("space"), "name": .string(name)])
  }
```

`SpaceKeys.swift`, in `Invite`: add the property and the init parameter. `Invite(link:)` decodes it through `Codable`, and the synthesized encoder leaves it out when nil, so nameless links keep their old bytes.

```swift
  public var server: String
  public var space: String
  public var secret: String
  /// The space's name when the invite was made; for showing before the first pull.
  public var name: String?

  public init(server: String, space: String, secret: String, name: String? = nil) {
    self.server = server
    self.space = space
    self.secret = secret
    self.name = name
  }
```

`Store.swift`, in `SpaceState` after `resync`:

```swift
  /// The name the invite gave, until the space's name record arrives.
  public var invitedName: String?
```

and in its `init(from:)` add:

```swift
    invitedName = try c.decodeIfPresent(String.self, forKey: .invitedName)
```

In `Store`, after `boards`:

```swift
  /// The space's name: its name record's, else the invite's; nil without either or when not syncing.
  public var name: String? {
    guard let space = state.space else { return nil }
    if let r = state.records[space]?.current, r.kind == "space", let n = r["name"]?.string { return n }
    return state.invitedName
  }

  public func rename(_ name: String) {
    guard let space = state.space else { return }
    apply([space: .fields(Records.space(name: name).fields)])
  }

  /// The invite to this space, named as it is now.
  public var invite: Invite? {
    guard var i = state.invite else { return nil }
    i.name = name
    return i
  }
```

In `merge`, replace `if item.record.kind == "board" { boards.insert(item.id) }` with:

```swift
      if item.record.kind == "board" || item.record.kind == "space" { boards.insert(item.id) }
```

In `join`, after `state.secret = invite.secret`:

```swift
    state.invitedName = invite.name
```

- [ ] **Step 5: Run the whole suite**

Run: `swift test --package-path BreezyKit`
Expected: all pass, including `invitesGoToLinksAndBack` (the nameless link is unchanged) and `aFileFromBeforeEpochsStillLoads`.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit -m "Name a space with a record of its own and in its invite"
```

---

### Task 2: Name records and named invites on the web

**Files:**
- Modify: `web/sync/records.js`, `web/sync/store.js`, `web/sync/crypto.js`
- Test: `web/test/store.test.js`, `web/test/crypto.test.js`

**Interfaces:**
- Consumes: the `namedInvite` fixture from Task 1.
- Produces: `spaceRecord(name)` in `records.js`; `store.name` (string or null), `store.rename(name)`, `store.invite` carries `name` when there is one; `emptyState()` has `invitedName: null`; `store.join({ server, space, secret, name })`; `inviteLink({ server, space, secret, name })`; `parseInvite` returns `name` when present.

- [ ] **Step 1: Write the failing tests**

`web/test/crypto.test.js`, add:

```js
test("an invite may name its space", () => {
  const named = { server: v.server, space: v.space, secret: v.secret, name: "Home & Work" };
  assert.equal(inviteLink(named), v.namedInvite);
  assert.deepEqual(parseInvite(v.namedInvite), named);
  assert.equal("name" in parseInvite(v.invite), false);
});
```

`web/test/store.test.js`, add (import `spaceRecord` from `../sync/records.js` and `newID` from `../rules.js`):

```js
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("a space is named by its record, else its invite", () => {
  const s = new Store();
  assert.equal(s.name, null);
  const space = newID();
  s.join({ server: "https://example.com/sync.php", space, secret: SECRET, name: "Ours" });
  assert.equal(s.name, "Ours");
  assert.deepEqual(s.pending(), []);
  s.rename("Home");
  assert.equal(s.name, "Home");
  assert.equal(s.invite.name, "Home");
  assert.deepEqual(s.boards(), []);
  assert.deepEqual(s.pending().map((p) => [p.id, p.record]), [[space, spaceRecord("Home")]]);
});

test("a merged name is reported", () => {
  const s = new Store();
  s.startSyncing("https://example.com/sync.php");
  const space = s.state.space;
  let heard = null;
  s.onChange = (boards) => (heard = [...boards]);
  s.merge([{ id: space, version: 1, record: spaceRecord("Work") }]);
  assert.equal(s.name, "Work");
  assert.deepEqual(heard, [space]);
});

test("a store not syncing has no name to change", () => {
  const s = new Store();
  s.rename("Home");
  assert.equal(s.name, null);
  assert.deepEqual(s.state.records, {});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test web/test/store.test.js web/test/crypto.test.js`
Expected: FAIL. `spaceRecord` is not exported, and `s.name` is undefined.

- [ ] **Step 3: Implement**

`web/sync/records.js`, after `boardRecord`:

```js
export const spaceRecord = (name) => ({ format: FORMAT, kind: "space", name });
```

`web/sync/store.js`:
- import `spaceRecord` alongside `boardRecord`.
- `emptyState` gains `invitedName: null`.
- Replace the `invite` getter and add `name` and `rename`:

```js
  get invite() {
    const { server, space, secret } = this.state;
    const name = this.name;
    return this.syncing ? { server, space, secret, ...(name ? { name } : {}) } : null;
  }

  /** The space's name: its name record's, else the invite's; null without either or when not syncing. */
  get name() {
    const s = this.state;
    if (!s.space) return null;
    const r = s.records[s.space]?.current;
    if (r?.kind === "space" && typeof r.name === "string") return r.name;
    return s.invitedName ?? null;
  }

  rename(name) {
    if (this.state.space) this.apply({ [this.state.space]: { fields: spaceRecord(name) } });
  }
```

- In `merge`, replace `if (record.kind === "board") boards.add(id);` with `if (record.kind === "board" || record.kind === "space") boards.add(id);`
- `join({ server, space, secret, name })` sets `this.state = { ...emptyState(), server, space, secret, invitedName: name ?? null };`

`web/sync/crypto.js`: keys go in sorted order, as Swift's `JSONEncoder` writes them, so both apps make the same link:

```js
export const inviteLink = ({ server, space, secret, name }) =>
  INVITE_PREFIX + encode(enc.encode(JSON.stringify({ ...(name ? { name } : {}), secret, server, space })));
```

In `parseInvite`, destructure `name` too and return `{ server, space, secret, ...(typeof name === "string" && name ? { name } : {}) }`.

- [ ] **Step 4: Run the web suite**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Name a space with a record of its own and in its invite on the web"
```

---

### Task 3: The Spaces container in BreezyKit

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Store.swift` (`StoreFile`)
- Create: `BreezyKit/Sources/BreezyKit/Spaces.swift`
- Create: `BreezyKit/Tests/BreezyKitTests/SpacesTests.swift`

**Interfaces:**
- Consumes: Task 1's `Store.name`, `rename`, `invite`.
- Produces:
  - `StoreFile.saveNow(_ state: SpaceState) throws`: writes before returning, after earlier saves.
  - `StoreFile.remove()`: deletes the file once earlier saves are done. Later saves do nothing.
  - `@MainActor final class Spaces` with:
    - `init(directory: URL, transport: ((SpaceState, SpaceKeys) -> Transport?)? = nil) throws`
    - `static let localName = "On this device"`, `static let unnamed = "Shared Space"`
    - `local: Group!`, `spaces: [Group]`, `groups: [Group]` (ordered)
    - `group(of board: String) -> Group?`, `group(space: String) -> Group?`
    - `newSpace(server:name:) -> Group`, `join(_ invite: Invite) -> Group`, `leave(_ group: Group)`
    - `move(_ id: String, to target: Group) -> String?`
    - `syncAll()`, `saveNow()`
    - callbacks `onChange: ((Group, Set<String>, Bool) -> Void)?`, `onStatus: ((Group) -> Void)?`, `onError: ((Error) -> Void)?`, `flushLocal: (() -> Void)?`
  - `Spaces.Group` with `store: Store`, `engine: SyncEngine`, `space: String?`, `name: String`.

- [ ] **Step 1: Write the failing tests**

Create `BreezyKit/Tests/BreezyKitTests/SpacesTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

private func tempDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

/// A fake server per space, made on first use.
final class Servers {
  var bySpace: [String: FakeServer] = [:]

  func server(_ space: String) -> FakeServer {
    if let s = bySpace[space] { return s }
    let s = FakeServer()
    bySpace[space] = s
    return s
  }

  func transport(_ state: SpaceState, _ keys: SpaceKeys) -> Transport? { FakeTransport(server(state.space!)) }
}

@MainActor @Test func aStoreFromBeforeSpacesBecomesItsSpace() throws {
  let dir = tempDirectory()
  let old = Store()
  old.startSyncing(server: testServer)
  let id = old.createBoard(title: "Plans")
  old.advance(to: 7)
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("space.json").path))
  #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Spaces/\(old.state.space!).json").path))
  #expect(spaces.spaces.count == 1)
  #expect(spaces.spaces[0].store.state == old.state)
  #expect(spaces.group(of: id) === spaces.spaces[0])
  #expect(spaces.local.store.boards.isEmpty)
}

@MainActor @Test func aStoreThatNeverSyncedBecomesOnThisDevice() throws {
  let dir = tempDirectory()
  let old = Store()
  _ = old.createBoard(title: "Plans")
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(spaces.spaces.isEmpty)
  #expect(spaces.local.store.boards.map(\.title) == ["Plans"])
  #expect(spaces.local.name == "On this device")
}

@MainActor @Test func anInterruptedMigrationRunsAgain() throws {
  let dir = tempDirectory()
  let old = Store()
  old.startSyncing(server: testServer)
  _ = old.createBoard(title: "Plans")
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  try StoreFile(url: dir.appendingPathComponent("Spaces/\(old.state.space!).json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(spaces.spaces.count == 1)
  #expect(spaces.spaces[0].store.boards.map(\.title) == ["Plans"])
}

@MainActor @Test func groupsComeOnThisDeviceFirstThenSpacesByName() throws {
  let spaces = try Spaces(directory: tempDirectory())
  let zed = spaces.newSpace(server: testServer, name: "Zed")
  let abe = spaces.newSpace(server: testServer, name: "Abe")
  #expect(spaces.groups.map(\.name) == ["On this device", "Abe", "Zed"])
  let id = zed.store.createBoard(title: "Plans")
  #expect(spaces.group(of: id) === zed)
  #expect(spaces.group(space: abe.space!) === abe)
  #expect(zed.store.pending.map(\.id).contains(zed.space!))
}

@MainActor @Test func aSpaceComesBackFromItsFile() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let g = spaces.newSpace(server: testServer, name: "Work")
  let id = g.store.createBoard(title: "Plans")
  spaces.saveNow()
  let again = try Spaces(directory: dir)
  #expect(again.spaces.map(\.name) == ["Work"])
  #expect(again.group(of: id)?.space == g.space)
}

@MainActor @Test func joiningASpaceAlreadyJoinedGivesItsGroup() throws {
  let spaces = try Spaces(directory: tempDirectory())
  let invite = Invite(server: testServer, space: newID(), secret: Base64URL.encode(randomBytes(32)), name: "Ours")
  let g = spaces.join(invite)
  #expect(g.name == "Ours")
  #expect(spaces.join(invite) === g)
  #expect(spaces.spaces.count == 1)
}

@MainActor @Test func leavingRemovesTheFileForGood() async throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let g = spaces.newSpace(server: testServer, name: "Work")
  _ = g.store.createBoard(title: "Plans")
  spaces.leave(g)
  try await Task.sleep(for: .seconds(0.8))
  #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("Spaces/\(g.space!).json").path))
  #expect(spaces.spaces.isEmpty)
  #expect(try Spaces(directory: dir).spaces.isEmpty)
}

@MainActor @Test func movingABoardCopiesItWithNewIDsAndDeletesTheOriginal() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let work = spaces.newSpace(server: testServer, name: "Work")
  let lane = Lane(id: "l", x: 0, y: 0, w: 480, h: 720, title: "Doing")
  let id = work.store.createBoard(title: "Plans", contents: board([card("a", 0, 0, "first"), card("b", 0, 0, "second")], [lane]))
  settle(work.store)
  guard let new = spaces.move(id, to: spaces.local) else { Issue.record("no move"); return }
  let moved = spaces.local.store.board(new)
  #expect(spaces.local.store.title(of: new) == "Plans")
  #expect(moved.cards.map(\.text) == ["first", "second"])
  #expect(moved.lanes.map(\.title) == ["Doing"])
  #expect(Set(moved.cards.map(\.id) + moved.lanes.map(\.id) + [new]).isDisjoint(with: ["a", "b", "l", id]))
  #expect(work.store.title(of: id) == nil)
  #expect(Set(work.store.pending.map(\.id)) == [id, "a", "b", "l"])
  let onDisk = try StoreFile(url: dir.appendingPathComponent("Spaces/local.json")).load()
  #expect(onDisk?.records[new] != nil)
}

@MainActor @Test func aMoveThatCannotBeWrittenLeavesTheBoardWhereItWas() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let work = spaces.newSpace(server: testServer, name: "Work")
  let id = spaces.local.store.createBoard(title: "Plans")
  spaces.saveNow()
  let folder = dir.appendingPathComponent("Spaces").path
  try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder)
  defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder) }
  var failed = false
  spaces.onError = { _ in failed = true }
  #expect(spaces.move(id, to: work) == nil)
  #expect(failed)
  #expect(spaces.local.store.title(of: id) == "Plans")
}

@MainActor @Test func aDeviceInTwoSpacesMovingBoardsEndsLikeEachSpace() async throws {
  let servers = Servers()
  let a = try Spaces(directory: tempDirectory(), transport: servers.transport)
  let x = a.newSpace(server: testServer, name: "X")
  let y = a.newSpace(server: testServer, name: "Y")
  for (g, t) in [(x, "x"), (y, "y")] {
    for n in 0..<3 { _ = g.store.createBoard(title: "\(t)\(n)", contents: board([card(newID(), 0, 0, t)])) }
  }
  await x.engine.sync()
  await y.engine.sync()
  let b = Device(servers.server(x.space!), joining: x.store.invite!)
  let c = Device(servers.server(y.space!), joining: y.store.invite!)
  await b.engine.sync()
  await c.engine.sync()
  var rng = SplitMix(state: 7)
  for _ in 0..<200 {
    switch Int.random(in: 0..<6, using: &rng) {
    case 0:
      let from = Bool.random(using: &rng) ? x : y
      if let id = from.store.boards.randomElement(using: &rng)?.id { _ = a.move(id, to: from === x ? y : x) }
    case 1: await x.engine.sync()
    case 2: await y.engine.sync()
    case 3: await b.engine.sync()
    case 4: await c.engine.sync()
    default:
      let d = Bool.random(using: &rng) ? b : c
      let row = Double(Int.random(in: 0..<20, using: &rng)) * 24
      if let id = d.store.boards.randomElement(using: &rng)?.id { d.edit(id) { _ = $0.addCard(x: 0, y: row) } }
    }
  }
  for _ in 0..<3 { for e in [x.engine, y.engine, b.engine, c.engine] { await e.sync() } }
  for (g, d) in [(x, b), (y, c)] {
    #expect(g.store.pending.isEmpty && d.store.pending.isEmpty)
    #expect(g.store.boards.map(\.id) == d.store.boards.map(\.id))
    for board in g.store.boards { #expect(g.store.board(board.id) == d.store.board(board.id)) }
  }
}
```

- [ ] **Step 2: Run them and see them fail**

Run: `swift test --package-path BreezyKit --filter Spaces`
Expected: compile error `cannot find 'Spaces' in scope`.

- [ ] **Step 3: Give `StoreFile` a save that reports failure, and removal**

In `Store.swift`, replace `StoreFile.scheduleSave` and `save` with the code below. Give the class `private var removed = false` beside `scheduled`, and add the helpers.

```swift
  /// Saves `state()` half a second from now, once however often it is asked meanwhile.
  public func scheduleSave(_ state: @escaping () -> SpaceState) {
    guard !scheduled, !removed else { return }
    scheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self else { return }
      scheduled = false
      save(state())
    }
  }

  /// With `wait`, returns once this and every earlier save are on disk.
  public func save(_ state: SpaceState, wait: Bool = false) {
    guard !removed else { return }
    let data: Data
    do {
      data = try Self.encode(state)
    } catch {
      onError?(error)
      return
    }
    let url = url
    let write = { [weak self] in
      do {
        try Self.write(data, to: url)
      } catch {
        DispatchQueue.main.async { self?.onError?(error) }
      }
    }
    if wait { queue.sync(execute: write) } else { queue.async(execute: write) }
  }

  /// Writes `state` before returning, after every earlier save; throws when it cannot.
  public func saveNow(_ state: SpaceState) throws {
    let data = try Self.encode(state)
    let url = url
    try queue.sync { try Self.write(data, to: url) }
  }

  /// Deletes the file once earlier saves are done; later saves do nothing.
  public func remove() {
    removed = true
    let url = url
    queue.sync { try? FileManager.default.removeItem(at: url) }
  }

  private static func encode(_ state: SpaceState) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return try e.encode(state)
  }

  private static func write(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
```

- [ ] **Step 4: Write `Spaces.swift`**

```swift
import Foundation

/// A device's groups of boards: its own, which never sync, and one per space it joined, each a
/// store with its own file and engine; see the spaces design.
@MainActor public final class Spaces {
  public static let localName = "On this device"
  public static let unnamed = "Shared Space"

  /// A store, the file it is saved to and the engine that syncs it.
  @MainActor public final class Group {
    public let store: Store
    public let engine: SyncEngine
    let file: StoreFile

    init(store: Store, engine: SyncEngine, file: StoreFile) {
      self.store = store
      self.engine = engine
      self.file = file
    }

    /// Nil for On this device.
    public var space: String? { store.state.space }
    public var name: String { space == nil ? Spaces.localName : store.name ?? Spaces.unnamed }
  }

  public let directory: URL
  public private(set) var local: Group!
  public private(set) var spaces: [Group] = []
  /// After a change to what a group's boards show, with the boards concerned and whether it came from the server.
  public var onChange: ((Group, Set<String>, Bool) -> Void)?
  public var onStatus: ((Group) -> Void)?
  /// A store file that could not be written.
  public var onError: ((Error) -> Void)?
  /// Called before merging, so that edits not yet in a store get there first.
  public var flushLocal: (() -> Void)?
  private let transport: ((SpaceState, SpaceKeys) -> Transport?)?

  /// The groups in `directory`/Spaces, after moving a store from before spaces, `directory`/space.json, among them.
  public init(directory: URL, transport: ((SpaceState, SpaceKeys) -> Transport?)? = nil) throws {
    self.directory = directory.appendingPathComponent("Spaces")
    self.transport = transport
    let old = StoreFile(url: directory.appendingPathComponent("space.json"))
    if let state = try old.load() {
      try file(for: state.space).saveNow(state)
      try FileManager.default.removeItem(at: old.url)
    }
    local = make(Store(state: try file(for: nil).load() ?? SpaceState()))
    let urls = (try? FileManager.default.contentsOfDirectory(at: self.directory, includingPropertiesForKeys: nil)) ?? []
    for url in urls.sorted(by: { $0.path < $1.path }) where url.pathExtension == "json" && url.lastPathComponent != "local.json" {
      if let state = try StoreFile(url: url).load(), state.space != nil { spaces.append(make(Store(state: state))) }
    }
  }

  private func file(for space: String?) -> StoreFile {
    StoreFile(url: directory.appendingPathComponent("\(space ?? "local").json"))
  }

  private func make(_ store: Store) -> Group {
    let engine = transport.map { SyncEngine(store: store, transport: $0) } ?? SyncEngine(store: store)
    let g = Group(store: store, engine: engine, file: file(for: store.state.space))
    let file = g.file
    store.onDirty = { [weak store] in
      guard let store else { return }
      file.scheduleSave { store.state }
    }
    store.onChange = { [weak self, weak g] boards, remote in
      guard let self, let g else { return }
      if !remote { g.engine.changed() }
      onChange?(g, boards, remote)
    }
    engine.onStatus = { [weak self, weak g] _ in
      guard let self, let g else { return }
      onStatus?(g)
    }
    engine.flushLocal = { [weak self] in self?.flushLocal?() }
    file.onError = { [weak self] in self?.onError?($0) }
    return g
  }

  /// On this device first, then the spaces by name.
  public var groups: [Group] {
    [local] + spaces.sorted { a, b in
      a.name == b.name ? a.space! < b.space! : a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
  }

  public func group(of board: String) -> Group? { groups.first { $0.store.title(of: board) != nil } }
  public func group(space: String) -> Group? { spaces.first { $0.space == space } }

  /// A new empty space on `server` named `name`.
  @discardableResult
  public func newSpace(server: String, name: String) -> Group {
    let store = Store()
    store.startSyncing(server: server)
    store.rename(name)
    return adopt(store)
  }

  /// `invite`'s space: the group already joined, or a new one.
  @discardableResult
  public func join(_ invite: Invite) -> Group {
    if let g = group(space: invite.space) { return g }
    let store = Store()
    store.join(invite)
    return adopt(store)
  }

  private func adopt(_ store: Store) -> Group {
    let g = make(store)
    spaces.append(g)
    g.file.save(store.state)
    return g
  }

  /// Forgets `group`'s space on this device: its file goes and its store stops saving. The server keeps it.
  public func leave(_ group: Group) {
    guard group !== local else { return }
    spaces.removeAll { $0 === group }
    group.store.onDirty = nil
    group.store.onChange = nil
    group.engine.onStatus = nil
    group.file.remove()
  }

  /// Board `id` copied into `target` with new ids, then deleted where it was once the copy is on
  /// disk. Nil when the copy cannot be written: the board stays where it was, and the copy too.
  public func move(_ id: String, to target: Group) -> String? {
    guard let source = group(of: id), source !== target, let title = source.store.title(of: id) else { return nil }
    var b = source.store.board(id)
    for i in b.cards.indices { b.cards[i].id = newID() }
    for i in b.lanes.indices { b.lanes[i].id = newID() }
    let new = target.store.createBoard(title: title, contents: b)
    do {
      try target.file.saveNow(target.store.state)
    } catch {
      onError?(error)
      return nil
    }
    source.store.deleteBoard(id)
    return new
  }

  /// A cycle for every space, each on its own.
  public func syncAll() {
    for g in spaces { Task { await g.engine.sync() } }
  }

  /// Writes every group's file before returning.
  public func saveNow() {
    for g in groups { g.file.save(g.store.state, wait: true) }
  }
}
```

- [ ] **Step 5: Run the suite**

Run: `swift test --package-path BreezyKit`
Expected: all pass. If the convergence test fails, print the first board that differs and check whether a moved board's cards reached both servers before the final rounds. Do not lower the step count.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit -m "Keep a device's own boards and each space it joined in groups"
```

---

### Task 4: The Spaces container on the web

**Files:**
- Modify: `web/sync/idb.js`
- Create: `web/sync/spaces.js`
- Create: `web/test/helpers/storage.js`, `web/test/spaces.test.js`

**Interfaces:**
- Consumes: Task 2's `store.name`, `rename`, `invite`, `join`.
- Produces:
  - `idb.js`: `loadAll() -> Promise<object>` (key → value), `saveState(key, value)`, `removeState(key)`, `storage = { loadAll, save: saveState, remove: removeState }`. `loadState` goes.
  - `spaces.js`: `LOCAL_NAME`, `UNNAMED`, and `class Spaces` with:
    - `static async open(storage, { transport, readOnly })`
    - `constructor(storage, states, { transport, readOnly })`
    - properties `fresh`, `readOnly`, `lastServer`, `local`, `spaces`
    - `groups()`, `groupOf(board)`, `groupFor(space)`, `get saveFailed`
    - `newSpace(server, name)`, `join(invite)`, `async leave(group)`, `async move(id, target) -> id | null`
    - `syncAll()`, `flushAll()`
    - callbacks `onChange(group, boards, remote)`, `onStatus(group)`, `onSaveError(error)`, `flushLocal()`
  - A group has `key`, `store`, `engine`, `saver`, `space`, `name`.

- [ ] **Step 1: Write the storage helper and failing tests**

`web/test/helpers/storage.js`:

```js
/** Storage in memory, as web/sync/idb.js keeps it; `failing` makes saves reject. */
export class MemoryStorage {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(structuredClone(entries)));
    this.failing = false;
  }

  async loadAll() {
    return structuredClone(Object.fromEntries(this.data));
  }

  async save(key, value) {
    if (this.failing) throw new Error("full");
    this.data.set(key, structuredClone(value));
  }

  async remove(key) {
    this.data.delete(key);
  }
}
```

`web/test/spaces.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Spaces } from "../sync/spaces.js";
import { Store } from "../sync/store.js";
import { MemoryStorage } from "./helpers/storage.js";
import { FakeServer, FakeTransport, SERVER, device, mulberry } from "./helpers/fake-server.js";
import { newID } from "../rules.js";
import * as R from "../rules.js";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const card = (id, text) => ({ id, x: 0, y: 0, w: 240, text, color: 1 });

/** A fake server per space, made on first use. */
function servers() {
  const all = new Map();
  const server = (space) => all.get(space) ?? all.set(space, new FakeServer()).get(space);
  return { server, transport: (state) => new FakeTransport(server(state.space)) };
}

test("a store from before spaces becomes its space", async () => {
  const old = new Store();
  old.startSyncing(SERVER);
  const id = old.createBoard("Plans");
  old.advance(7);
  const storage = new MemoryStorage({ space: old.state });
  const spaces = await Spaces.open(storage);
  assert.equal(storage.data.has("space"), false);
  assert.deepEqual(storage.data.get(`space:${old.state.space}`), old.state);
  assert.equal(spaces.spaces.length, 1);
  assert.equal(spaces.spaces[0].store.state.cursor, 7);
  assert.equal(spaces.groupOf(id), spaces.spaces[0]);
  assert.deepEqual(spaces.local.store.boards(), []);
  assert.equal(spaces.fresh, false);
});

test("a store that never synced becomes On this device", async () => {
  const old = new Store();
  old.createBoard("Plans");
  const spaces = await Spaces.open(new MemoryStorage({ space: old.state }));
  assert.deepEqual(spaces.spaces, []);
  assert.deepEqual(spaces.local.store.boards().map((b) => b.title), ["Plans"]);
  assert.equal(spaces.local.name, "On this device");
});

test("an interrupted migration runs again", async () => {
  const old = new Store();
  old.startSyncing(SERVER);
  old.createBoard("Plans");
  const spaces = await Spaces.open(new MemoryStorage({ space: old.state, [`space:${old.state.space}`]: old.state }));
  assert.equal(spaces.spaces.length, 1);
  assert.deepEqual(spaces.spaces[0].store.boards().map((b) => b.title), ["Plans"]);
});

test("a device with nothing stored is fresh", async () => {
  assert.equal((await Spaces.open(new MemoryStorage())).fresh, true);
});

test("groups come On this device first, then spaces by name", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const zed = spaces.newSpace(SERVER, "Zed");
  const abe = spaces.newSpace(SERVER, "Abe");
  assert.deepEqual(spaces.groups().map((g) => g.name), ["On this device", "Abe", "Zed"]);
  const id = zed.store.createBoard("Plans");
  assert.equal(spaces.groupOf(id), zed);
  assert.equal(spaces.groupFor(abe.space), abe);
  await spaces.flushAll();
  const again = await Spaces.open(storage);
  assert.deepEqual(again.groups().map((g) => g.name), ["On this device", "Abe", "Zed"]);
  assert.equal(again.lastServer, SERVER);
});

test("joining a space already joined gives its group", async () => {
  const spaces = await Spaces.open(new MemoryStorage());
  const invite = { server: SERVER, space: newID(), secret: SECRET, name: "Ours" };
  const g = spaces.join(invite);
  assert.equal(g.name, "Ours");
  assert.equal(spaces.join(invite), g);
  assert.equal(spaces.spaces.length, 1);
});

test("leaving removes the space's key for good", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const g = spaces.newSpace(SERVER, "Work");
  g.store.createBoard("Plans");
  await spaces.leave(g);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(storage.data.has(g.key), false);
  assert.deepEqual(spaces.spaces, []);
  assert.deepEqual((await Spaces.open(storage)).spaces, []);
});

test("moving a board copies it with new ids and deletes it where it was", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const work = spaces.newSpace(SERVER, "Work");
  const lane = { id: "l", x: 0, y: 0, w: 480, h: 720, title: "Doing" };
  const id = work.store.createBoard("Plans", { cards: [card("a", "first"), card("b", "second")], lanes: [lane] });
  for (const p of work.store.pending()) work.store.accepted(p.id, 1, p.record);
  const moved = await spaces.move(id, spaces.local);
  const b = spaces.local.store.board(moved);
  assert.equal(spaces.local.store.title(moved), "Plans");
  assert.deepEqual(b.cards.map((c) => c.text), ["first", "second"]);
  assert.deepEqual(b.lanes.map((l) => l.title), ["Doing"]);
  for (const x of [moved, ...b.cards.map((c) => c.id), ...b.lanes.map((l) => l.id)]) assert.ok(!["a", "b", "l", id].includes(x));
  assert.equal(work.store.title(id), null);
  assert.deepEqual(work.store.pending().map((p) => p.id).sort(), [id, "a", "b", "l"].sort());
  assert.ok(storage.data.get("local").records[moved]);
});

test("a move whose copy can't be saved leaves the board where it was", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const work = spaces.newSpace(SERVER, "Work");
  const id = spaces.local.store.createBoard("Plans");
  await spaces.flushAll();
  storage.failing = true;
  assert.equal(await spaces.move(id, work), null);
  assert.equal(spaces.local.store.title(id), "Plans");
  assert.equal(spaces.saveFailed, true);
});

test("a device in two spaces moving boards ends like each space", async () => {
  const { server, transport } = servers();
  const a = await Spaces.open(new MemoryStorage(), { transport });
  const x = a.newSpace(SERVER, "X");
  const y = a.newSpace(SERVER, "Y");
  for (const [g, t] of [[x, "x"], [y, "y"]]) for (let n = 0; n < 3; n++) g.store.createBoard(`${t}${n}`, { cards: [card(newID(), t)], lanes: [] });
  await x.engine.sync();
  await y.engine.sync();
  const b = device(server(x.space), x.store.invite);
  const c = device(server(y.space), y.store.invite);
  await b.engine.sync();
  await c.engine.sync();
  const rnd = mulberry(7);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let step = 0; step < 200; step++) {
    const roll = Math.floor(rnd() * 6);
    if (roll === 0) {
      const from = rnd() < 0.5 ? x : y;
      const board = pick(from.store.boards());
      if (board) await a.move(board.id, from === x ? y : x);
    } else if (roll <= 4) {
      await [x.engine, y.engine, b.engine, c.engine][roll - 1].sync();
    } else {
      const d = rnd() < 0.5 ? b : c;
      const row = Math.floor(rnd() * 20) * 24;
      const board = pick(d.store.boards());
      if (board) d.edit(board.id, (bd) => R.addCard(bd, 0, row));
    }
  }
  for (let i = 0; i < 3; i++) for (const e of [x.engine, y.engine, b.engine, c.engine]) await e.sync();
  for (const [g, d] of [[x, b], [y, c]]) {
    assert.deepEqual(g.store.pending(), []);
    assert.deepEqual(d.store.pending(), []);
    assert.deepEqual(g.store.boards(), d.store.boards());
    for (const { id } of g.store.boards()) assert.deepEqual(g.store.board(id), d.store.board(id));
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test web/test/spaces.test.js`
Expected: FAIL with `Cannot find module '…/web/sync/spaces.js'`.

- [ ] **Step 3: Make IndexedDB keyed**

In `web/sync/idb.js`, replace `loadState`, `put` and `saveState` with:

```js
/** Every key's value: `local`, `space:<id>`, `server`, and `space` from before spaces. */
export function loadAll() {
  return attempt((d) => new Promise((resolve, reject) => {
    const out = {};
    const q = d.transaction("state").objectStore("state").openCursor();
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return resolve(out);
      out[c.key] = c.value;
      c.continue();
    };
    q.onerror = () => reject(q.error);
  }));
}

function change(d, apply) {
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    apply(t.objectStore("state"));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

/** Saves `value` under `key`, trying once more on a reopened database. */
export async function saveState(key, value) {
  try {
    return await attempt((d) => change(d, (s) => s.put(value, key)));
  } catch {
    return attempt((d) => change(d, (s) => s.put(value, key)));
  }
}

export function removeState(key) {
  return attempt((d) => change(d, (s) => s.delete(key)));
}

export const storage = { loadAll, save: saveState, remove: removeState };
```

Update the file's top comment to `// The groups' states in IndexedDB, a key each.`

- [ ] **Step 4: Write `web/sync/spaces.js`**

```js
// A device's groups of boards: its own, which never sync, and one per space it joined, each a store with its saver
// and engine, as BreezyKit's Spaces; see the spaces design.
import { Store, withFreshIDs } from "./store.js";
import { Saver } from "./saver.js";
import { SyncEngine } from "./engine.js";

export const LOCAL_NAME = "On this device";
export const UNNAMED = "Shared Space";

class Group {
  constructor(key, store, engine, saver) {
    Object.assign(this, { key, store, engine, saver });
  }

  /** Null for On this device. */
  get space() {
    return this.store.state.space;
  }

  get name() {
    return this.space ? this.store.name ?? UNNAMED : LOCAL_NAME;
  }
}

const keyOf = (state) => (state?.space ? `space:${state.space}` : "local");

export class Spaces {
  /** The groups in `storage`, after moving a store from before spaces among them; `fresh` when it held nothing. */
  static async open(storage, options = {}) {
    const all = await storage.loadAll();
    const fresh = !Object.keys(all).length;
    if (all.space) {
      const key = keyOf(all.space);
      await storage.save(key, all.space);
      await storage.remove("space");
      all[key] = all.space;
      delete all.space;
    }
    const spaces = new Spaces(storage, all, options);
    spaces.fresh = fresh;
    return spaces;
  }

  constructor(storage, states = {}, { transport, readOnly = false } = {}) {
    this.storage = storage;
    this.transport = transport;
    this.readOnly = readOnly;
    this.fresh = false;
    this.lastServer = typeof states.server === "string" ? states.server : null;
    /** After a change to what a group's boards show, with the boards concerned and whether it came from the server. */
    this.onChange = () => {};
    this.onStatus = () => {};
    /** After a save fails. */
    this.onSaveError = () => {};
    /** Called before merging, so that edits not yet in a store get there first. */
    this.flushLocal = () => {};
    this.local = this.make("local", new Store(states.local ?? undefined));
    this.spaces = Object.entries(states)
      .filter(([k, s]) => k.startsWith("space:") && s?.space)
      .map(([k, s]) => this.make(k, new Store(s)));
  }

  make(key, store) {
    const engine = new SyncEngine(store, this.transport ? { transport: this.transport } : {});
    const saver = new Saver(() => this.storage.save(key, store.state));
    saver.enabled = !this.readOnly;
    const g = new Group(key, store, engine, saver);
    saver.onError = (error) => this.onSaveError(error);
    store.onDirty = () => saver.schedule();
    store.onChange = (boards, remote) => {
      if (!remote) engine.changed();
      this.onChange(g, boards, remote);
    };
    engine.onStatus = () => this.onStatus(g);
    engine.flushLocal = () => this.flushLocal();
    return g;
  }

  /** On this device first, then the spaces by name. */
  groups() {
    const cmp = (a, b) => a.name.localeCompare(b.name) || (a.space < b.space ? -1 : a.space > b.space ? 1 : 0);
    return [this.local, ...[...this.spaces].sort(cmp)];
  }

  groupOf(board) {
    return this.groups().find((g) => g.store.title(board) !== null) ?? null;
  }

  groupFor(space) {
    return this.spaces.find((g) => g.space === space) ?? null;
  }

  get saveFailed() {
    return this.groups().some((g) => g.saver.failed);
  }

  /** A new empty space on `server` named `name`; the server is remembered for the next one. */
  newSpace(server, name) {
    const store = new Store();
    store.startSyncing(server);
    store.rename(name);
    this.lastServer = server;
    if (!this.readOnly) this.storage.save("server", server).catch(() => {});
    return this.adopt(store);
  }

  /** `invite`'s space: the group already joined, or a new one. */
  join(invite) {
    const known = this.groupFor(invite.space);
    if (known) return known;
    const store = new Store();
    store.join(invite);
    return this.adopt(store);
  }

  adopt(store) {
    const g = this.make(keyOf(store.state), store);
    this.spaces.push(g);
    g.saver.schedule();
    return g;
  }

  /** Forgets `group`'s space on this device: its key goes and its store stops saving. The server keeps it. */
  async leave(group) {
    if (group === this.local) return;
    this.spaces = this.spaces.filter((g) => g !== group);
    group.store.onDirty = group.store.onChange = group.engine.onStatus = () => {};
    group.saver.enabled = false;
    await group.saver.writing;
    if (!this.readOnly) await this.storage.remove(group.key);
  }

  /**
   * Board `id` copied into `target` with new ids, then deleted where it was once the copy is saved. Null when the copy
   * can't be saved: the board stays where it was, and the copy too.
   */
  async move(id, target) {
    const source = this.groupOf(id);
    const title = source?.store.title(id);
    if (!source || source === target || title == null) return null;
    const created = target.store.createBoard(title, withFreshIDs(source.store.board(id)));
    await target.saver.flush();
    if (target.saver.failed) return null;
    source.store.deleteBoard(id);
    return created;
  }

  /** A cycle for every space, each on its own. */
  syncAll() {
    for (const g of this.spaces) g.engine.sync();
  }

  flushAll() {
    return Promise.all(this.groups().map((g) => g.saver.flush()));
  }
}
```

- [ ] **Step 5: Run the web suite**

Run: `node --test web/test/*.test.js`
Expected: all pass. (`web/library.js` still imports `loadState`. Nothing under test imports it, and Task 6 rewrites it.)

- [ ] **Step 6: Commit**

```bash
git add web/sync web/test
git commit -m "Keep a device's own boards and each space it joined in groups on the web"
```

---

### Task 5: The Mac app in groups

**Files:**
- Modify: `Breezy/Library/Library.swift`, `Breezy/Library/BoardsWindowController.swift`, `Breezy/Library/SyncMenu.swift`
- Modify: `Breezy/App/AppDelegate.swift`, `Breezy/App/MainMenu.swift`
- Modify: `Breezy/Document/BoardDocument.swift` (`displayName`)
- Modify: `Breezy/Support/DebugLaunch.swift:36`, `Breezy/Support/SelfTest.swift:147,167`, `BreezyUITests/BreezyUITests.swift:21`

**Interfaces:**
- Consumes: `Spaces`, `Spaces.Group` (Task 3).
- Produces: `Library.spaces`, `Library.currentGroup`, `Library.move(_:to:)`, `Library.leave(_:)`, `BoardsWindowController.selectedGroup`, `BoardsWindowController.select(_:)`; `AppDelegate` actions `newSpace(_:)`, `joinSpace(_:)`, `renameSpace(_:)`, `shareInvite(_:)`, `leaveSpace(_:)`, `moveBoard(_:)`; `final class Move: NSObject` (`board`, `group`).

- [ ] **Step 1: `Library.swift`**

Replace the class body (keep the `Notification.Name` extension) with:

```swift
/// The boards on this Mac: their groups, each with its file and sync engine, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let spaces: Spaces
  private var timer: Timer?
  /// Boards whose windows are closing, so that the close's own flush can't close them again.
  private var closing: Set<String> = []

  init(directory: URL) throws {
    spaces = try Spaces(directory: directory)
    spaces.onChange = { [weak self] group, boards, remote in self?.changed(group, boards, remote: remote) }
    spaces.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    spaces.onError = { NSApp.presentError($0) }
    spaces.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.syncNow() }
    }
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  /// Each space's status, prefixed by its name, for the Breezy menu.
  var statusLines: [String] {
    spaces.groups.filter { $0.space != nil }.flatMap { g in g.engine.status.lines().map { "\(g.name) — \($0)" } }
  }

  /// The group of the key board window, else of the Boards window's selection, else On this device.
  var currentGroup: Spaces.Group {
    if let d = NSApp.keyWindow?.windowController?.document as? BoardDocument, let g = spaces.group(of: d.boardID) { return g }
    return BoardsWindowController.shared.selectedGroup ?? spaces.local
  }

  func syncNow() { spaces.syncAll() }

  /// Every 5 s while a board or the Boards window shows.
  private func poll() {
    let shown = NSApp.windows.contains {
      ($0.windowController is BoardWindowController || $0.windowController is BoardsWindowController) && $0.occlusionState.contains(.visible)
    }
    if shown { syncNow() }
  }

  /// Ends edits and writes every group before quitting.
  func saveNow() {
    for d in documents {
      d.windowController?.canvas.endEditing()
      d.binding.flush()
    }
    spaces.saveNow()
  }

  /// A change in `group`: its boards' windows follow, and all its windows retitle when its name changed.
  func changed(_ group: Spaces.Group, _ boards: Set<String>, remote: Bool) {
    let renamed = group.space.map { boards.contains($0) } ?? false
    for d in documents where !closing.contains(d.boardID) {
      let mine = boards.contains(d.boardID)
      guard mine || (renamed && group.store.title(of: d.boardID) != nil) else { continue }
      if mine {
        if group.store.title(of: d.boardID) == nil {
          closing.insert(d.boardID)
          d.close()
          closing.remove(d.boardID)
          continue
        }
        if remote { d.binding.pull() }
      }
      d.windowController?.synchronizeWindowTitleWithDocumentName()
    }
    NotificationCenter.default.post(name: .boardsChanged, object: nil)
  }

  /// Board `id`'s window, made if need be; nil when there is no such board.
  @discardableResult
  func open(_ id: String, display: Bool = true) -> BoardWindowController? {
    let doc: BoardDocument
    if let open = documents.first(where: { $0.boardID == id }) {
      doc = open
    } else {
      guard let group = spaces.group(of: id) else { return nil }
      doc = BoardDocument(boardID: id, store: group.store)
      NSDocumentController.shared.addDocument(doc)
      doc.makeWindowControllers()
    }
    if display { doc.showWindows() }
    syncNow()
    return doc.windowController
  }

  /// Moves board `id` to `target`; its window, if open, closes with the original and opens on the copy.
  func move(_ id: String, to target: Spaces.Group) {
    let doc = documents.first { $0.boardID == id }
    doc?.windowController?.canvas.endEditing()
    doc?.binding.flush()
    guard let new = spaces.move(id, to: target) else { return }
    if doc != nil { open(new) }
  }

  /// Closes `group`'s boards and forgets its space on this Mac.
  func leave(_ group: Spaces.Group) {
    for d in documents where group.store.title(of: d.boardID) != nil { d.close() }
    spaces.leave(group)
    NotificationCenter.default.post(name: .boardsChanged, object: nil)
  }
}
```

- [ ] **Step 2: `BoardDocument.displayName`, `DebugLaunch`, `SelfTest`, UI tests**

`BoardDocument.swift`:

```swift
  override var displayName: String! {
    get {
      MainActor.assumeIsolated {
        guard let g = Library.shared.spaces.group(of: boardID), let title = g.store.title(of: boardID) else { return "Board" }
        return g.space == nil ? title : "\(title) — \(g.name)"
      }
    }
    set {}
  }
```

`DebugLaunch.swift:36`: `Library.shared.store.createBoard(` → `Library.shared.spaces.local.store.createBoard(`.

`SelfTest.swift` lines 147 and 167: `appendingPathComponent("space.json")` → `appendingPathComponent("Spaces/local.json")`.

`BreezyUITests.swift:21`: `store.appendingPathComponent("space.json")` → `store.appendingPathComponent("Spaces/local.json")`.

- [ ] **Step 3: Menus and actions**

`MainMenu.swift`: replace the three sync items with:

```swift
      item("New Space…", #selector(AppDelegate.newSpace(_:))),
      item("Join Space…", #selector(AppDelegate.joinSpace(_:))),
      item("Share Invite", #selector(AppDelegate.shareInvite(_:))),
      item("Rename Space…", #selector(AppDelegate.renameSpace(_:))),
      item("Leave Space…", #selector(AppDelegate.leaveSpace(_:))),
```

`SyncMenu.swift`: `#selector(AppDelegate.startSyncing(_:))` → `#selector(AppDelegate.newSpace(_:))`.

`AppDelegate.swift`:
- In `applicationWillFinishLaunching`'s alert: `"The file is left as it is: \(dir.appendingPathComponent("space.json").path)"` → `"The files are left as they are: \(dir.appendingPathComponent("Spaces").path)"`.
- `newBoard`: `MainActor.assumeIsolated { _ = Library.shared.open(Library.shared.currentGroup.store.createBoard(title: "New Board")) }`
- `validateMenuItem`:

```swift
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(shareInvite(_:)), #selector(renameSpace(_:)), #selector(leaveSpace(_:)):
      return MainActor.assumeIsolated { Library.shared.currentGroup.space != nil }
    default: return true
    }
  }
```

- Replace `startSyncing`, `joinSpace` and `shareInvite` with the code below, and add `Move`:

```swift
  @MainActor private func confirm(_ message: String, _ info: String, _ button: String, destructive: Bool = false) -> Bool {
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = info
    alert.addButton(withTitle: button).hasDestructiveAction = destructive
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  @MainActor private func show(_ group: Spaces.Group) {
    BoardsWindowController.shared.showWindow(nil)
    BoardsWindowController.shared.select(group)
  }

  @MainActor @objc func newSpace(_ sender: Any?) {
    let name = field("Name"), server = field("https://example.com/breezy/sync.php")
    server.stringValue = UserDefaults.standard.string(forKey: "BreezyLastServer") ?? ""
    for f in [name, server] { f.widthAnchor.constraint(equalToConstant: 320).isActive = true }
    let stack = NSStackView(views: [name, server])
    stack.orientation = .vertical
    stack.spacing = 8
    stack.frame = NSRect(x: 0, y: 0, width: 320, height: 56)
    let alert = NSAlert()
    alert.messageText = "New Space"
    alert.informativeText = "A name for the space and the address of your Breezy server. Boards are encrypted on this Mac; the server can’t read them."
    alert.accessoryView = stack
    alert.addButton(withTitle: "Create")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = name
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let title = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let url = server.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    guard Invite.validServer(url) else { return tell("That isn’t a server address", "Use an https:// address ending in sync.php.") }
    UserDefaults.standard.set(url, forKey: "BreezyLastServer")
    let g = Library.shared.spaces.newSpace(server: url, name: title)
    Library.shared.syncNow()
    show(g)
  }

  @MainActor @objc func joinSpace(_ sender: Any?) {
    let input = field("Invite link")
    let alert = NSAlert()
    alert.messageText = "Join Space"
    alert.informativeText = "Paste the invite link from another device."
    alert.accessoryView = input
    alert.addButton(withTitle: "Join")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    guard let invite = Invite(link: input.stringValue) else {
      return tell("That isn’t an invite link", "Copy the whole link from Share Invite on the other device.")
    }
    let g = Library.shared.spaces.join(invite)
    Library.shared.syncNow()
    show(g)
  }

  @MainActor @objc func renameSpace(_ sender: Any?) {
    let g = Library.shared.currentGroup
    guard g.space != nil else { return }
    let input = field("Name")
    input.stringValue = g.name
    let alert = NSAlert()
    alert.messageText = "Rename Space"
    alert.informativeText = "The new name shows on every device in the space."
    alert.accessoryView = input
    alert.addButton(withTitle: "Rename")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let name = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty && name != g.name { g.store.rename(name) }
  }

  @MainActor @objc func shareInvite(_ sender: Any?) {
    guard let link = Library.shared.currentGroup.store.invite?.link else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(link, forType: .string)
    // clipboard managers leave out what is marked concealed
    NSPasteboard.general.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    tell("Invite link copied", "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.")
  }

  @MainActor @objc func leaveSpace(_ sender: Any?) {
    let g = Library.shared.currentGroup
    guard g.space != nil,
          confirm("Leave “\(g.name)”?", "Its boards are removed from this device. Others in the space keep them.", "Leave", destructive: true)
    else { return }
    Library.shared.leave(g)
  }

  @MainActor @objc func moveBoard(_ sender: NSMenuItem) {
    guard let m = sender.representedObject as? Move, let source = Library.shared.spaces.group(of: m.board),
          let title = source.store.title(of: m.board) else { return }
    if source.space != nil {
      guard confirm("Move “\(title)” to “\(m.group.name)”?", "It is removed from “\(source.name)” on every device.", "Move") else { return }
    }
    Library.shared.move(m.board, to: m.group)
  }
```

and at the end of the file:

```swift
/// A board and the group a menu item moves it to.
final class Move: NSObject {
  let board: String
  let group: Spaces.Group

  init(board: String, group: Spaces.Group) {
    self.board = board
    self.group = group
  }
}
```

- [ ] **Step 4: The Boards window as a source list**

Rewrite `BoardsWindowController.swift`. Keep its window setup, buttons, status field, observers and `keyDown`, swapping the table for an outline:

```swift
import AppKit
import BreezyKit

/// The Boards window: each group's boards, to open, rename, add, move and delete.
@MainActor final class BoardsWindowController: NSWindowController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSTextFieldDelegate, NSMenuDelegate {
  static let shared = BoardsWindowController()

  /// A group, or a board in one.
  final class Row {
    let group: Spaces.Group
    let board: (id: String, title: String)?
    var children: [Row] = []

    init(group: Spaces.Group, board: (id: String, title: String)? = nil) {
      self.group = group
      self.board = board
    }
  }

  private let outline = NSOutlineView()
  let status = NSTextField(labelWithString: "")
  private var rows: [Row] = []

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Boards"
    window.minSize = NSSize(width: 280, height: 240)
    super.init(window: window)
    window.center()
    window.setFrameAutosaveName("Boards")
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title"))
    outline.addTableColumn(column)
    outline.outlineTableColumn = column
    outline.headerView = nil
    outline.style = .sourceList
    outline.rowHeight = 28
    outline.floatsGroupRows = false
    outline.dataSource = self
    outline.delegate = self
    outline.target = self
    outline.doubleAction = #selector(openClicked)
    let menu = NSMenu()
    menu.delegate = self
    outline.menu = menu
    let scroll = NSScrollView()
    scroll.documentView = outline
    scroll.hasVerticalScroller = true
    let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "New Board")!, target: nil, action: #selector(AppDelegate.newBoard(_:)))
    let remove = NSButton(image: NSImage(systemSymbolName: "minus", accessibilityDescription: "Delete Board")!, target: self, action: #selector(delete(_:)))
    for b in [add, remove] { b.bezelStyle = .accessoryBarAction }
    status.textColor = .secondaryLabelColor
    status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    status.lineBreakMode = .byTruncatingTail
    let bar = NSStackView(views: [add, remove, status])
    bar.spacing = 4
    bar.edgeInsets = NSEdgeInsets(top: 6, left: 8, bottom: 8, right: 12)
    let stack = NSStackView(views: [scroll, bar])
    stack.orientation = .vertical
    stack.spacing = 0
    stack.alignment = .leading
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    NSLayoutConstraint.activate([scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), bar.widthAnchor.constraint(equalTo: stack.widthAnchor)])
    window.contentView = stack
    NotificationCenter.default.addObserver(forName: .boardsChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.reload() }
    }
    NotificationCenter.default.addObserver(forName: .syncStatusChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateStatus() }
    }
    reload()
  }

  required init?(coder: NSCoder) { fatalError() }

  private var selectedRow: Row? { outline.item(atRow: outline.selectedRow) as? Row }
  var selectedGroup: Spaces.Group? { selectedRow?.group }

  /// On this device shows only when it has boards or the Mac is in no space.
  func reload() {
    let spaces = Library.shared.spaces
    let kept = selectedRow.map { ($0.group, $0.board?.id) }
    rows = spaces.groups.filter { $0.space != nil || spaces.spaces.isEmpty || !$0.store.boards.isEmpty }.map { g in
      let r = Row(group: g)
      r.children = g.store.boards.map { Row(group: g, board: $0) }
      return r
    }
    outline.reloadData()
    outline.expandItem(nil, expandChildren: true)
    if let (group, board) = kept, let groupRow = rows.first(where: { $0.group === group }) {
      var row: Row? = groupRow
      if let board { row = groupRow.children.first { $0.board?.id == board } }
      let i = row.map { outline.row(forItem: $0) } ?? -1
      if i >= 0 { outline.selectRowIndexes([i], byExtendingSelection: false) }
    }
    updateStatus()
  }

  func select(_ group: Spaces.Group) {
    guard let r = rows.first(where: { $0.group === group }) else { return }
    let i = outline.row(forItem: r)
    guard i >= 0 else { return }
    outline.selectRowIndexes([i], byExtendingSelection: false)
    outline.scrollRowToVisible(i)
  }

  func updateStatus() {
    guard let g = selectedGroup, g.space != nil else { return status.stringValue = "" }
    status.stringValue = g.engine.status.lines().joined(separator: " · ")
  }

  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? Row)?.children.count ?? rows.count }
  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { (item as? Row)?.children[index] ?? rows[index] }
  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? Row)?.board == nil }
  func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { (item as? Row)?.board == nil }
  func outlineViewSelectionDidChange(_ notification: Notification) { updateStatus() }

  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
    guard let row = item as? Row else { return nil }
    let cell = NSTableCellView()
    let field = NSTextField(string: row.board?.title ?? row.group.name)
    field.isBordered = false
    field.drawsBackground = false
    field.isEditable = row.board != nil
    field.delegate = self
    field.identifier = row.board.map { NSUserInterfaceItemIdentifier($0.id) }
    field.translatesAutoresizingMaskIntoConstraints = false
    cell.addSubview(field)
    cell.textField = field
    NSLayoutConstraint.activate([
      field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
      field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
      field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
    ])
    return cell
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    guard let field = obj.object as? NSTextField, let id = field.identifier?.rawValue,
          let row = rows.flatMap(\.children).first(where: { $0.board?.id == id }), let b = row.board else { return }
    let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != b.title else {
      field.stringValue = b.title
      return
    }
    row.group.store.renameBoard(b.id, title)
  }

  @objc private func openClicked() {
    guard let id = (outline.item(atRow: outline.clickedRow) as? Row)?.board?.id else { return }
    Library.shared.open(id)
  }

  /// Edit → Delete, ⌫ in the list, the − button and the context menu.
  @objc func delete(_ sender: Any?) {
    guard let row = selectedRow, let b = row.board, let window else { return NSSound.beep() }
    let alert = NSAlert()
    alert.messageText = "Delete “\(b.title)”?"
    alert.informativeText = row.group.space == nil
      ? "This can’t be undone." : "It is deleted on every device in “\(row.group.name)”. This can’t be undone."
    alert.addButton(withTitle: "Delete").hasDestructiveAction = true
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in
      guard response == .alertFirstButtonReturn else { return }
      MainActor.assumeIsolated {
        Library.shared.documents.first { $0.boardID == b.id }?.close()
        row.group.store.deleteBoard(b.id)
      }
    }
  }

  /// A board's Move to and Delete, or a space's Rename, Share and Leave; the clicked row is selected so they act on it.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    guard let row = outline.item(atRow: outline.clickedRow) as? Row else { return }
    outline.selectRowIndexes([outline.clickedRow], byExtendingSelection: false)
    if let b = row.board {
      let targets = NSMenu()
      for g in Library.shared.spaces.groups where g !== row.group {
        let i = NSMenuItem(title: g.name, action: #selector(AppDelegate.moveBoard(_:)), keyEquivalent: "")
        i.representedObject = Move(board: b.id, group: g)
        targets.addItem(i)
      }
      let move = NSMenuItem(title: "Move to", action: nil, keyEquivalent: "")
      move.submenu = targets
      move.isEnabled = !targets.items.isEmpty
      menu.addItem(move)
      let delete = NSMenuItem(title: "Delete", action: #selector(delete(_:)), keyEquivalent: "")
      delete.target = self
      menu.addItem(delete)
    } else if row.group.space != nil {
      menu.addItem(NSMenuItem(title: "Rename Space…", action: #selector(AppDelegate.renameSpace(_:)), keyEquivalent: ""))
      menu.addItem(NSMenuItem(title: "Share Invite", action: #selector(AppDelegate.shareInvite(_:)), keyEquivalent: ""))
      menu.addItem(NSMenuItem(title: "Leave Space…", action: #selector(AppDelegate.leaveSpace(_:)), keyEquivalent: ""))
    }
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 51 || event.keyCode == 117 { delete(nil) } else { super.keyDown(with: event) }
  }
}
```

- [ ] **Step 5: Build and run the existing checks**

Run:

```bash
mise exec -- xcodegen generate
xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build build 2>&1 | grep -E "error|warning: .*Spaces|BUILD" | tail -20
swift test --package-path BreezyKit
scripts/selftest.sh
```

Expected: `BUILD SUCCEEDED`; BreezyKit passes; every selftest passes (`close-while-editing` and `close-blank-card` read `Spaces/local.json`).

- [ ] **Step 6: Check by hand**

Run the Debug app with a throwaway store: `build/Build/Products/Debug/Breezy.app/Contents/MacOS/Breezy -BreezyStore "$(mktemp -d)"` (note the folder for the relaunch). In another terminal, `server/dev.sh`.
1. New Space… named "Work" on `http://127.0.0.1:58566/sync.php`. The Boards window shows the "Work" group selected, and its status reads "Synced just now".
2. `+` adds "New Board" under Work. Open it: the title reads "New Board — Work".
3. Right-click the board → Move to → On this device → Move. The window reopens titled "New Board", and the board sits under On this device.
4. Right-click Work → Leave Space… → Leave. The group goes. Quit and relaunch with the same `-BreezyStore`: it stays gone.
5. Copy a pre-change `space.json` (any from `~/Library/Application Support/Breezy/` backed up first) into a new store directory and launch on it. The boards appear under its space, or under On this device if it never synced.

- [ ] **Step 7: Commit**

```bash
git add Breezy BreezyUITests
git commit -m "List boards by space on the Mac, with New, Join, Rename, Share and Leave Space and Move to"
```

---

### Task 6: The web app in groups

**Files:**
- Modify: `web/sheet.js`, `web/index.html`, `web/style.css`, `web/ui.js`, `web/library.js`

**Interfaces:**
- Consumes: `Spaces`, `storage` (Task 4); `statusLines` from `web/sync/engine.js`.
- Produces: `ask({ …, choices })` resolves `{ choice: index }`; `Library` methods `newSpace()`, `join(text?)`, `renameSpace()`, `share()`, `leaveSpace()`, `newBoard(group)`, `edit(id)`, `statusLines()`; `ui.act` handles `new-space`, `join`, `rename-space`, `share`, `leave-space`.

- [ ] **Step 1: Choices in the sheet**

`web/index.html`: inside `<form class="sheet-card">`, before `.sheet-buttons`, add `<div class="sheet-choices" hidden></div>`.

`web/sheet.js`: add `choices = []` to the parameters, and update the doc comment ("…{ choice: i } for the i-th of `choices`…"). Inside the `Promise` executor, after `done` is defined:

```js
    const list = sheet.querySelector(".sheet-choices");
    list.replaceChildren(...choices.map((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = () => done({ choice: i });
      return b;
    }));
    list.hidden = !choices.length;
```

`web/style.css`, after `.sheet-buttons .danger`:

```css
.sheet-choices { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.sheet-choices button { height: 44px; border-radius: 999px; background: var(--press); color: var(--ink); }
```

- [ ] **Step 2: Markup and styles for groups and the space menu**

`web/index.html`, in `#boards`: replace `<ul class="boards-list"></ul>` and the New Board button with `<div class="boards-groups"></div>`. In `.menu.more`, replace the status, Start Syncing and Share Invite lines with:

```html
  <p class="status" hidden></p>
  <button data-act="new-space">New Space</button>
```

keeping Join Space and Version. After `.menu.more`, add:

```html
<div class="menu space" hidden>
  <button data-act="rename-space">Rename Space</button>
  <button data-act="share">Share Invite</button>
  <button data-act="leave-space">Leave Space</button>
</div>
```

`web/style.css`: replace the `.boards-list { … }` rule's `margin: 16px 0 0` with `margin: 8px 0 0`, delete the `.boards-new` rule, and add:

```css
.boards-group { margin-top: 24px; }
.boards-group header { display: flex; align-items: center; min-height: 44px; padding-left: 16px; }
.boards-group header div { flex: 1; min-width: 0; }
.boards-group h2 { margin: 0; font-size: 20px; line-height: 25px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boards-group .status { margin: 0; color: var(--ink2); font-size: 13px; line-height: 18px; }
.boards-group header .edit { width: 44px; height: 44px; color: var(--ink3); }
.boards-list .new { flex: 1; height: 52px; padding: 0 16px; text-align: left; }
.menu.space { position: fixed; bottom: auto; left: auto; translate: none; transform-origin: 100% 0; }
```

- [ ] **Step 3: `ui.js`**

Replace `updateSync`:

```js
  /** The ⋯ menu's status: the open board's space, and whether boards can be saved. */
  updateSync() {
    const lib = this.app.library;
    if (!lib) return;
    const status = this.$(".menu.more .status");
    status.textContent = lib.statusLines().join("\n");
    status.hidden = !status.textContent;
  }
```

In `act`, delete the `new-board` and `start-sync` cases, and add:

```js
      case "new-space": this.closeMenu(); return app.library?.newSpace();
      case "rename-space": this.closeMenu(); return app.library?.renameSpace();
      case "leave-space": this.closeMenu(); return app.library?.leaveSpace();
```

(keep `join` and `share`).

- [ ] **Step 4: Rewrite `web/library.js`**

```js
import { withFreshIDs } from "./sync/store.js";
import { Spaces } from "./sync/spaces.js";
import { storage } from "./sync/idb.js";
import { Binding } from "./binding.js";
import { sampleBoard } from "./sample.js";
import { ask } from "./sheet.js";
import { statusLines } from "./sync/engine.js";
import { inviteLink, parseInvite, validServer } from "./sync/crypto.js";
import * as R from "./rules.js";

const MORE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

/** The boards on this device: their groups in IndexedDB, the board list and the open board. */
export class Library {
  static async open(app) {
    let spaces;
    try {
      spaces = await Spaces.open(storage);
    } catch (error) {
      // saving now could overwrite boards that failed to load
      console.warn("boards not loaded", error);
      spaces = new Spaces(storage, {}, { readOnly: true });
    }
    const lib = new Library(app, spaces);
    const link = location.hash.includes("#join=") ? location.href : null;
    if (link) history.replaceState(null, "", location.pathname + location.search);
    if (spaces.fresh && !link) spaces.local.store.createBoard("Sample", withFreshIDs(sampleBoard()));
    lib.showList();
    if (link) lib.join(link);
    spaces.syncAll();
    return lib;
  }

  constructor(app, spaces) {
    this.app = app;
    this.spaces = spaces;
    this.id = null;
    this.group = null;
    this.binding = null;
    /** The space whose menu was opened last. */
    this.menuGroup = null;
    app.library = this;
    spaces.onChange = (group, boards, remote) => this.changed(group, boards, remote);
    spaces.onStatus = () => {
      this.renderStatus();
      app.ui.updateSync();
    };
    spaces.onSaveError = (error) => {
      console.warn("boards not saved", error);
      app.ui.updateSync();
    };
    spaces.flushLocal = () => this.binding?.flush();
    setInterval(() => !document.hidden && spaces.syncAll(), 5000);
    document.addEventListener("visibilitychange", () => document.hidden || spaces.syncAll());
    const change = app.model.onChange;
    app.model.onChange = () => {
      change();
      this.binding?.changed();
    };
    this.restack = (b) => R.gravity(b, (id) => {
      const c = R.card(b, id);
      return c ? app.view.frontHeight(c.text, c.w) : 0;
    });
    const hide = () => {
      this.binding?.flush();
      spaces.flushAll();
    };
    document.addEventListener("visibilitychange", () => document.hidden && hide());
    addEventListener("pagehide", hide);
    document.querySelector('[data-act="boards"]').hidden = false;
  }

  changed(group, boards, remote) {
    if (this.id && group === this.group && boards.has(this.id)) {
      if (group.store.title(this.id) === null) return this.showList();
      if (remote) this.binding.pull();
    }
    if (!this.id) this.renderList();
    this.app.ui.updateSync();
  }

  open(id) {
    this.binding?.flush();
    this.binding = null;
    const group = this.spaces.groupOf(id);
    if (!group) return this.showList();
    this.id = id;
    this.group = group;
    const b = group.store.board(id);
    this.restack(b);
    document.body.dataset.screen = "board";
    this.app.load(b);
    this.binding = new Binding(group.store, this.app.model, id, this.restack);
    this.app.ui.updateSync();
    group.engine.sync();
  }

  showList() {
    this.app.endEditing();
    this.binding?.flush();
    this.binding = null;
    this.id = null;
    this.group = null;
    document.body.dataset.screen = "boards";
    this.renderList();
    this.app.ui.updateSync();
  }

  /** A section per group; On this device only when it has boards or the device is in no space. */
  renderList() {
    const { spaces } = this;
    const shown = spaces.groups().filter((g) => g.space || !spaces.spaces.length || g.store.boards().length);
    document.querySelector(".boards-groups").replaceChildren(...shown.map((g) => this.renderGroup(g)));
    this.renderStatus();
  }

  renderGroup(g) {
    const section = document.createElement("section");
    section.className = "boards-group";
    section.dataset.group = g.key;
    const header = document.createElement("header");
    const titles = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = g.name;
    const status = document.createElement("p");
    status.className = "status";
    titles.append(h2, status);
    header.append(titles);
    if (g.space) {
      const more = document.createElement("button");
      more.className = "edit";
      more.setAttribute("aria-label", `${g.name} options`);
      more.innerHTML = MORE;
      more.addEventListener("pointerdown", () => this.pointMenu(more, g));
      this.app.ui.menus.attach(more, document.querySelector(".menu.space"));
      header.append(more);
    }
    const ul = document.createElement("ul");
    ul.className = "boards-list";
    for (const { id, title } of g.store.boards()) ul.append(this.renderBoard(id, title));
    const li = document.createElement("li");
    const add = document.createElement("button");
    add.className = "new strong";
    add.textContent = "New Board";
    add.addEventListener("click", () => this.newBoard(g));
    li.append(add);
    ul.append(li);
    section.append(header, ul);
    return section;
  }

  renderBoard(id, title) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.className = "open";
    open.textContent = title || "Untitled";
    open.addEventListener("click", () => this.open(id));
    const edit = document.createElement("button");
    edit.className = "edit";
    edit.setAttribute("aria-label", `Rename, move or delete ${title || "Untitled"}`);
    edit.innerHTML = MORE;
    edit.addEventListener("click", () => this.edit(id));
    li.append(open, edit);
    return li;
  }

  /** Each space's first status line under its name, in place, so a tap under way isn't lost to a new list. */
  renderStatus() {
    for (const g of this.spaces.spaces) {
      const p = document.querySelector(`.boards-group[data-group="${g.key}"] .status`);
      if (p) p.textContent = statusLines(g.engine.status)[0];
    }
  }

  /** Puts the space menu under `button`, for `group`. */
  pointMenu(button, group) {
    this.menuGroup = group;
    const r = button.getBoundingClientRect();
    const menu = document.querySelector(".menu.space");
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${innerWidth - r.right}px`;
  }

  reveal(group) {
    document.querySelector(`.boards-group[data-group="${group.key}"]`)?.scrollIntoView({ block: "nearest" });
  }

  async newBoard(group) {
    const r = await ask({ title: "New Board", value: "", placeholder: "Name", ok: "Create" });
    const title = r?.value?.trim();
    if (title && this.spaces.groups().includes(group)) this.open(group.store.createBoard(title));
  }

  async edit(id) {
    const group = this.spaces.groupOf(id);
    const title = group?.store.title(id);
    if (title == null) return;
    const others = this.spaces.groups().filter((g) => g !== group);
    const r = await ask({ title: "Rename Board", value: title, ok: "Rename", danger: "Delete Board", choices: others.length ? ["Move to…"] : [] });
    if (r?.choice === 0) return this.move(id, group, others);
    if (r?.value?.trim() && r.value.trim() !== title) return group.store.renameBoard(id, r.value.trim());
    if (!r?.danger) return;
    const sure = await ask({
      title: `Delete “${title}”?`,
      message: group.space ? `It is deleted on every device in “${group.name}”.` : "This can’t be undone.",
      ok: null, danger: "Delete",
    });
    if (sure?.danger) group.store.deleteBoard(id);
  }

  async move(id, group, others) {
    const title = group.store.title(id);
    const r = await ask({ title: `Move “${title}” to`, choices: others.map((g) => g.name), ok: null });
    const target = others[r?.choice];
    if (!target || !this.spaces.groups().includes(target)) return;
    if (group.space) {
      const sure = await ask({ title: `Move “${title}” to “${target.name}”?`, message: `It is removed from “${group.name}” on every device.`, ok: "Move" });
      if (!sure) return;
    }
    if (await this.spaces.move(id, target)) return;
    await ask({ title: "Boards can’t be saved on this device", message: `“${title}” stays in “${group.name}”.`, cancel: null });
  }

  /** The ⋯ menu's lines: whether boards can be saved, and the open board's space status. */
  statusLines() {
    const unsaved = this.spaces.readOnly || this.spaces.saveFailed;
    return [...(unsaved ? ["Boards can’t be saved on this device"] : []), ...(this.group?.space ? statusLines(this.group.engine.status) : [])];
  }

  async newSpace() {
    const named = await ask({ title: "New Space", message: "Its boards are shared with whoever you send its invite.", value: "", placeholder: "Name", ok: "Next" });
    const name = named?.value?.trim();
    if (!name) return;
    const r = await ask({
      title: "Server",
      message: "The address of your Breezy server. Boards are encrypted on this device; the server can’t read them.",
      value: this.spaces.lastServer ?? "", placeholder: "https://example.com/breezy/sync.php", ok: "Create",
    });
    const server = r?.value?.trim();
    if (!server) return;
    if (!validServer(server)) return ask({ title: "That isn’t a server address", message: "Use an https:// address ending in sync.php.", cancel: null });
    const g = this.spaces.newSpace(server, name);
    this.showList();
    this.reveal(g);
    await g.engine.sync();
  }

  /** Joins the space in `text`, a link opened or pasted, or asks for one; a link opened asks first. */
  async join(text) {
    const opened = text !== undefined;
    if (!opened) {
      const r = await ask({ title: "Join Space", message: "Paste the invite link from another device.", value: "", placeholder: "Invite link", ok: "Join" });
      if (!r) return;
      text = r.value;
    }
    const invite = parseInvite(text);
    if (!invite) return ask({ title: "That isn’t an invite link", message: "Copy the whole link from Share Invite on the other device.", cancel: null });
    const known = this.spaces.groupFor(invite.space);
    if (!known) {
      const host = new URL(invite.server).hostname;
      const title = invite.name ? `Join “${invite.name}” on ${host}?` : `Join the space on ${host}?`;
      if (opened && !(await ask({ title, ok: "Join" }))) return;
    }
    const g = known ?? this.spaces.join(invite);
    this.showList();
    this.reveal(g);
    await g.engine.sync();
  }

  async renameSpace(g = this.menuGroup) {
    if (!g?.space) return;
    const r = await ask({ title: "Rename Space", message: "The new name shows on every device in the space.", value: g.name, ok: "Rename" });
    const name = r?.value?.trim();
    if (name && name !== g.name) g.store.rename(name);
  }

  async leaveSpace(g = this.menuGroup) {
    if (!g?.space) return;
    const sure = await ask({ title: `Leave “${g.name}”?`, message: "Its boards are removed from this device. Others in the space keep them.", ok: null, danger: "Leave" });
    if (!sure?.danger) return;
    if (this.group === g) this.showList();
    await this.spaces.leave(g);
    this.renderList();
  }

  async share(g = this.menuGroup) {
    const invite = g?.store.invite;
    if (!invite) return;
    const link = inviteLink(invite);
    try {
      await navigator.share({ url: link });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return ask({
        title: "Share Invite",
        message: "Copy this link and paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.",
        value: link, ok: "OK", cancel: null,
      });
    }
    await ask({
      title: "Invite link copied",
      message: "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.",
      cancel: null,
    });
  }
}
```

- [ ] **Step 5: Run the web suite**

Run: `node --test web/test/*.test.js`
Expected: all pass. (`web/sw.js` lists no modules, so the new file needs no precache entry.)

- [ ] **Step 6: Check by hand in a browser and the simulator**

`server/dev.sh` in one terminal, and in another `python3 -m http.server 58565 --directory web`. Open http://localhost:58565/.
1. On a fresh profile the list shows "On this device" with Sample. ⋯ → New Space "Work", server `http://127.0.0.1:58566/sync.php`. A Work section appears with "Synced just now", and On this device stays because it has Sample.
2. Sample's ⋯ → Move to… → Work. Sample moves under Work and On this device disappears.
3. Work's ⋯ menu opens under its button: Share Invite copies a link. Open it in a private window: it asks "Join “Work” on 127.0.0.1?" and shows Sample under Work, with no sample board of its own.
4. Rename Space in one window. The other shows the new name within 5 s.
5. Leave Space in the private window. Work disappears there and stays in the first window.
6. In the iOS simulator (memory: `scripts/sim-touch.py`), tap a space's ⋯ and slide onto Rename Space: the menu picks by sliding, as the top ⋯ does.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "List boards by space on the web, with New, Join, Rename, Share and Leave Space and Move to"
```

---

### Task 7: README and both apps together

**Files:**
- Modify: `README.md` (Sync section)

- [ ] **Step 1: Update the README**

In `## Sync`, replace "Two people share one space of boards across their devices." with "Each space is a set of boards shared with whoever has its invite; a device can join several and keeps boards of its own under On this device." Add the spaces spec path beside the sync spec's. Replace the closing sentence "Then Start Syncing on one device … with the link." with "Then New Space on one device with the address of `sync.php`, Share Invite from its menu, and Join Space on the others with the link."

- [ ] **Step 2: Check across both apps**

With `server/dev.sh` running, the Mac Debug app and the web app on localhost:
1. On the Mac, create spaces "A" and "B" and share A's invite to the web app. The web app shows only A.
2. On the Mac, move a board from B to A. It appears on the web within 5 s.
3. On the web, rename A. The Mac's Boards window and the board window titles follow.
4. On the web, leave A. The Mac keeps A and its boards.

- [ ] **Step 3: Run everything**

```bash
swift test --package-path BreezyKit
node --test web/test/*.test.js
server/test.sh
xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test
```

Expected: all pass. If XCUITest cannot activate the app, run `scripts/selftest.sh` instead, as the README says.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Describe spaces in the README"
```
