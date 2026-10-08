# Breezy sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people share one space of boards across Macs and browsers, end-to-end encrypted, through a PHP and MySQL server that only stores what it cannot read.

**Architecture:** Each card, lane and board is a record: plaintext JSON on the devices, an AES-GCM blob on the server. Each device keeps every record's base (last pulled) and current value, pulls what changed after a cursor, merges three ways field by field, and pushes its pending records with conditional writes. The sync core is written twice, in BreezyKit (Swift) and `web/sync/` (JavaScript), and shared JSON fixtures keep both in agreement. Boards stop being files: the Mac keeps a store file in Application Support and a Boards window, and the web app keeps its store in IndexedDB and opens on a board list.

**Tech Stack:** Swift 6 toolchain in Swift 5 mode, swift-testing, CryptoKit, AppKit; plain ES modules with `node:test`, WebCrypto, IndexedDB; PHP 8 with PDO (MySQL in production, SQLite in tests).

**Spec:** `docs/superpowers/specs/2026-10-08-breezy-sync-design.md`

## Global Constraints

- BreezyKit depends on Apple frameworks only (Foundation, CryptoKit). The web app takes no dependency and keeps no build step.
- Record plaintext carries `"format": 1`. New ids are 16 random bytes as base64url (22 characters, no prefix); a space id is 16 bytes, a secret 32 bytes.
- HKDF-SHA256 with an empty salt derives the key (info `breezy key`, AES-256-GCM) and the token (info `breezy token`, 32 bytes). A blob is a 12-byte nonce followed by ciphertext and tag; its additional data is space id ‖ record id.
- Limits: blob ≤ 65,536 bytes, request ≤ 1,048,576 bytes, pages of 500.
- A sync cycle runs when a board opens, when the app comes to the foreground, every 5 s while a board is visible, and 1 s after a local change. Failures retry after 5 s, doubling to 60 s. Three refused pushes in one cycle back off the same way.
- Invite links start `https://arlol.github.io/breezy/#join=`. CORS allows `https://arlol.github.io` and `http://localhost:58565`.
- Status lines, exactly: `Not syncing`, `Synced just now`, `Synced N min ago`, `Offline`, `Offline — N change(s) waiting`, `Can’t reach server`, `Not in this space any more`, `N unreadable change(s)`, `Update Breezy to see all changes`, `Card too long to sync`.
- Match the surrounding code: two-space indents, doc comments on types and non-obvious functions, few other comments, no new abstractions beyond those named here. Commit messages are one imperative line plus a short body when it helps, ending with `Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi`.

## Review Focus

1. **Devices that measure text differently.** Restacking after a merge must change only what the device shows. If it pushed positions, a Mac and a phone would push each other's layouts forever. Pinned by `restackingAMergeIsShownButNotWritten` (Task 6) and its JavaScript twin (Task 12).
2. **Typing while the other device's changes arrive.** Typed text must survive, and the merge must wait for the edit to end. Pinned by `aMergeDuringAGestureWaitsAndKeepsTheTypedText` (Task 6, Task 12).
3. **Closing or reloading right after an edit.** The change must be on disk. Pinned by `saveCanWaitForTheWrite` (Task 5) and `flush writes at once what is waiting` (Task 12).
4. **A pasted invite with text around it** (Messages adds punctuation; people paste whole sentences). It must still join, and junk must be refused. Pinned by `aPastedInviteMayHaveTextAroundIt` and `whatIsNotAnInviteIsRefused` (Task 4, Task 11).
5. **A server that lost its data** (restored database, new host). Writes for records it no longer has must be accepted, so devices rebuild it. Pinned by `a record the server lost is written again` (Task 14).

---

## File map

| File | Responsibility |
|---|---|
| `BreezyKit/Sources/BreezyKit/Base64URL.swift` | base64url, random bytes |
| `…/JSONValue.swift` | a JSON value type for record fields |
| `…/Record.swift` | `Record`, `Change`, `Records` (Board ↔ records, field diffs) |
| `…/OrderKey.swift` | fractional order keys, keeping keys on reorder |
| `…/Merge.swift` | three-way record merge |
| `…/Rebase.swift` | board-level three-way for undo |
| `…/BoardModel.swift` | field-level undo, `applyRemote`, `onEdit`, `onGestureEnd` |
| `…/SpaceKeys.swift` | key derivation, seal and open, `Invite` |
| `…/Store.swift` | `SpaceState`, `Store`, `StoreFile` |
| `…/BoardBinding.swift` | one open board ↔ the store |
| `…/Sync.swift` | wire types, `Transport`, `HTTPTransport`, `SyncStatus`, `SyncEngine` |
| `BreezyKit/Tests/Fixtures/*.json` | cases shared by Swift and JavaScript tests |
| `web/sync/base64.js`, `order-key.js`, `records.js`, `merge.js`, `crypto.js`, `store.js`, `saver.js`, `idb.js`, `engine.js` | the same core in JavaScript |
| `web/rebase.js`, `web/model.js` | undo |
| `web/binding.js`, `web/library.js`, `web/sheet.js` | the web app's store, list and sheets |
| `server/sync.php`, `schema.sql`, `config.example.php`, `.htaccess`, `test.sh`, `dev.sh`, `test/sync.test.mjs` | the server |
| `Breezy/Library/Library.swift`, `BoardsWindowController.swift`, `SyncMenu.swift` | the Mac's store, Boards window, sync menu |

---

### Task 1: Records and order keys in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Base64URL.swift`, `JSONValue.swift`, `Record.swift`, `OrderKey.swift`
- Create: `BreezyKit/Tests/Fixtures/order-key.json`
- Modify: `BreezyKit/Sources/BreezyKit/Model.swift:76-78` (`newID`), `Edits.swift` (two `newID` calls), `Format.swift` (two `newID` calls)
- Modify: `BreezyKit/Tests/BreezyKitTests/Fixtures.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/OrderKeyTests.swift`, `RecordTests.swift`

**Interfaces:**
- Produces: `Base64URL.encode(_: Data) -> String`, `Base64URL.decode(_: String) -> Data?`, `randomBytes(_: Int) -> Data`, `newID() -> String`
- Produces: `enum JSONValue { string, number, bool, array, object, null }` with `.string`, `.number`, `.array` accessors
- Produces: `struct Record { fields: [String: JSONValue]; subscript(String) -> JSONValue?; kind; deleted; format; board; static format = 1; static marker(_ kind: String) -> Record }`
- Produces: `enum Change { case fields([String: JSONValue]); case deleted(String) }`
- Produces: `Records.card(_:board:order:)`, `Records.lane(_:board:)`, `Records.board(title:)`, `Records.board(_ id: String, from: [String: Record]) -> Board`, `Records.changes(from: Board, to: Board, board: String, orders: [String: String]) -> [String: Change]`
- Produces: `OrderKey.between(_ a: String, _ b: String?) -> String`, `OrderKey.valid(_:) -> Bool`, `OrderKey.assign(_ ids: [String], keeping: [String: String]) -> [String: String]`
- Produces (tests): `fixture(_ name: String) throws -> Data`

- [ ] **Step 1: Add the shared fixture and the fixture reader**

`BreezyKit/Tests/Fixtures/order-key.json`:

```json
{
  "between": [
    ["", null, "V"], ["V", null, "l"], ["", "V", "G"], ["V", "W", "VV"], ["z", null, "zV"],
    ["a", "a1", "a0V"], ["0V", "1", "0l"], ["", "1", "0V"], ["", "01", "00V"]
  ],
  "assign": [
    { "name": "fresh ids count up", "ids": ["a", "b", "c"], "keys": {}, "result": { "a": "V", "b": "l", "c": "t" } },
    { "name": "keys in order stay", "ids": ["a", "b", "c"], "keys": { "a": "V", "b": "l", "c": "t" }, "result": { "a": "V", "b": "l", "c": "t" } },
    { "name": "a raised card goes after the last", "ids": ["b", "c", "a"], "keys": { "a": "V", "b": "l", "c": "t" }, "result": { "a": "x", "b": "l", "c": "t" } },
    { "name": "a new card between two", "ids": ["a", "d", "b"], "keys": { "a": "V", "b": "l" }, "result": { "a": "V", "b": "l", "d": "d" } },
    { "name": "equal keys from two devices part", "ids": ["a", "b", "c"], "keys": { "a": "V", "b": "V", "c": "l" }, "result": { "a": "G", "b": "V", "c": "l" } },
    { "name": "a broken key is replaced", "ids": ["a", "b"], "keys": { "a": "V0", "b": "l" }, "result": { "a": "O", "b": "l" } }
  ]
}
```

At the top of `BreezyKit/Tests/BreezyKitTests/Fixtures.swift`, add `import Foundation` above `@testable import BreezyKit`, and append:

```swift
/// A file from BreezyKit/Tests/Fixtures, which the web app's tests read too.
func fixture(_ name: String) throws -> Data {
  let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  return try Data(contentsOf: tests.appendingPathComponent("Fixtures").appendingPathComponent(name))
}
```

- [ ] **Step 2: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/OrderKeyTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

private struct OrderCases: Decodable {
  struct Assign: Decodable {
    var name: String
    var ids: [String]
    var keys: [String: String]
    var result: [String: String]
  }
  var between: [[String?]]
  var assign: [Assign]
}

@Test func orderKeysMatchTheSharedCases() throws {
  let cases = try JSONDecoder().decode(OrderCases.self, from: fixture("order-key.json"))
  for c in cases.between { #expect(OrderKey.between(c[0]!, c[1]) == c[2]!) }
  for c in cases.assign { #expect(OrderKey.assign(c.ids, keeping: c.keys) == c.result, "\(c.name)") }
}

@Test func keysMadeOneAfterAnotherKeepIncreasing() {
  var keys: [String] = []
  var last = ""
  for _ in 0..<200 {
    last = OrderKey.between(last, nil)
    keys.append(last)
  }
  #expect(keys == keys.sorted())
  #expect(Set(keys).count == 200)
  #expect(keys.allSatisfy(OrderKey.valid))
}

@Test func aKeyBetweenTwoSortsBetweenThem() {
  let lo = "V"
  var hi = "W"
  for _ in 0..<50 {
    let m = OrderKey.between(lo, hi)
    #expect(lo < m && m < hi)
    hi = m
  }
}
```

`BreezyKit/Tests/BreezyKitTests/RecordTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

private func records(_ changes: [String: Change]) -> [String: Record] {
  changes.compactMapValues { change in
    guard case .fields(let f) = change else { return nil }
    return Record(f)
  }
}

@Test func aBoardGoesToRecordsAndBack() {
  let b = board([card("c1", 24, 48, "One"), card("c2", 0, 0, "Two")], [lane("l1", 0, 0)])
  #expect(Records.board("B", from: records(Records.changes(from: Board(), to: b, board: "B", orders: [:]))) == b)
}

@Test func onlyChangedFieldsAreWritten() {
  let old = board([card("c1", 0, 0, "One")])
  var new = old
  new.setColor(["c1"], 3)
  #expect(Records.changes(from: old, to: new, board: "B", orders: ["c1": "V"]) == ["c1": .fields(["color": .number(3)])])
}

@Test func reorderingWritesOneOrderKey() {
  let old = board([card("a", 0, 0), card("b", 0, 0)])
  let new = board([card("b", 0, 0), card("a", 0, 0)])
  #expect(Records.changes(from: old, to: new, board: "B", orders: ["a": "V", "b": "l"]) == ["b": .fields(["order": .string("G")])])
}

@Test func removedItemsAreMarkedDeleted() {
  let old = board([card("a", 0, 0)], [lane("l", 0, 0)])
  #expect(Records.changes(from: old, to: Board(), board: "B", orders: ["a": "V"]) == ["a": .deleted("card"), "l": .deleted("lane")])
}

@Test func badValuesFromAnotherDeviceFallBack() {
  let r = Record(["format": .number(1), "kind": .string("card"), "board": .string("B"), "color": .number(9), "pos": .string("x")])
  let c = Records.board("B", from: ["c": r]).cards[0]
  #expect(c.color == 5 && c.x == 0 && c.text == "" && c.notes == nil && c.w == Metrics.cardWidth)
}

@Test func deletedRecordsAndOtherBoardsAreLeftOut() {
  let mine = Records.card(card("a", 0, 0), board: "B", order: "V")
  let other = Records.card(card("b", 0, 0), board: "C", order: "V")
  #expect(Records.board("B", from: ["a": mine, "b": other, "d": .marker("card")]).cards.map(\.id) == ["a"])
}

@Test func recordsRoundTripAsJSON() throws {
  let r = Records.card(card("a", 24, 0, "Hi"), board: "B", order: "V")
  #expect(try JSONDecoder().decode(Record.self, from: JSONEncoder().encode(r)) == r)
}

@Test func newIDsAre16RandomBytes() {
  let id = newID()
  #expect(id.count == 22)
  #expect(Base64URL.decode(id)?.count == 16)
  #expect(newID() != id)
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `swift test --package-path BreezyKit --filter 'OrderKey|Record|newIDs'`
Expected: build failure: `cannot find 'OrderKey' in scope`, `cannot find type 'Record'`.

- [ ] **Step 4: Write the implementation**

`BreezyKit/Sources/BreezyKit/Base64URL.swift`:

```swift
import Foundation

/// Base64 with `-` and `_` and no padding, as ids, keys and blobs travel.
public enum Base64URL {
  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  public static func decode(_ text: String) -> Data? {
    guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    var b = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b += String(repeating: "=", count: (4 - b.count % 4) % 4)
    return Data(base64Encoded: b)
  }
}

public func randomBytes(_ count: Int) -> Data {
  var g = SystemRandomNumberGenerator()
  return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &g) })
}
```

`BreezyKit/Sources/BreezyKit/JSONValue.swift`:

```swift
import Foundation

/// A JSON value: a record's fields hold these, so that fields this version does not know survive.
public enum JSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let s): try c.encode(s)
    case .number(let n): try c.encode(n)
    case .bool(let b): try c.encode(b)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    case .null: try c.encodeNil()
    }
  }

  public var string: String? { if case .string(let s) = self { s } else { nil } }
  public var number: Double? { if case .number(let n) = self { n } else { nil } }
  public var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
}
```

`BreezyKit/Sources/BreezyKit/Record.swift`:

```swift
import Foundation

/// A board, lane or card as it syncs: the JSON object its blob decrypts to.
public struct Record: Codable, Equatable, Sendable {
  public static let format = 1
  public var fields: [String: JSONValue]

  public init(_ fields: [String: JSONValue]) { self.fields = fields }
  public init(from decoder: Decoder) throws { fields = try [String: JSONValue](from: decoder) }
  public func encode(to encoder: Encoder) throws { try fields.encode(to: encoder) }

  public subscript(key: String) -> JSONValue? {
    get { fields[key] }
    set { fields[key] = newValue }
  }

  public var kind: String? { self["kind"]?.string }
  public var deleted: Bool { self["deleted"] == .bool(true) }
  public var format: Int { self["format"]?.number.map { Int($0) } ?? 0 }
  public var board: String? { self["board"]?.string }

  /// What stays of a deleted record, for good.
  public static func marker(_ kind: String) -> Record {
    Record(["format": .number(Double(format)), "kind": .string(kind), "deleted": .bool(true)])
  }
}

/// A local edit to one record: fields to set (all of them for a new record), or its deletion.
public enum Change: Equatable, Sendable {
  case fields([String: JSONValue])
  case deleted(String)
}

/// Boards as records and back. A card's `pos` and a lane's `pos` and `size` are pairs, so that a merge
/// never takes x from one move and y from another.
public enum Records {
  static func pair(_ a: Double, _ b: Double) -> JSONValue { .array([.number(a), .number(b)]) }

  static func unpair(_ v: JSONValue?) -> (Double, Double)? {
    guard let a = v?.array, a.count == 2, let x = a[0].number, let y = a[1].number, x.isFinite, y.isFinite else { return nil }
    return (x, y)
  }

  public static func card(_ c: Card, board: String, order: String) -> Record {
    Record([
      "format": .number(Double(Record.format)), "kind": .string("card"), "board": .string(board),
      "text": .string(c.text), "notes": .string(c.notes ?? ""), "color": .number(Double(c.color)),
      "pos": pair(c.x, c.y), "w": .number(c.w), "order": .string(order),
    ])
  }

  public static func lane(_ l: Lane, board: String) -> Record {
    Record([
      "format": .number(Double(Record.format)), "kind": .string("lane"), "board": .string(board),
      "title": .string(l.title), "pos": pair(l.x, l.y), "size": pair(l.w, l.h),
    ])
  }

  public static func board(title: String) -> Record {
    Record(["format": .number(Double(Record.format)), "kind": .string("board"), "title": .string(title)])
  }

  /// Board `id` as `records` describe it: cards by order key, then id; lanes by id.
  public static func board(_ id: String, from records: [String: Record]) -> Board {
    var cards: [(order: String, card: Card)] = []
    var lanes: [Lane] = []
    for (rid, r) in records where !r.deleted && r.board == id {
      let (x, y) = unpair(r["pos"]) ?? (0, 0)
      switch r.kind {
      case "card":
        let notes = r["notes"]?.string ?? ""
        let color = Int(r["color"]?.number ?? 1)
        let w = r["w"]?.number.flatMap { $0.isFinite ? $0 : nil } ?? Metrics.cardWidth
        let c = Card(id: rid, x: x, y: y, w: w, text: r["text"]?.string ?? "", notes: notes.isEmpty ? nil : notes, color: min(max(color, 1), 5))
        cards.append((r["order"]?.string ?? "", c))
      case "lane":
        let (w, h) = unpair(r["size"]) ?? (Metrics.laneWidth, Metrics.laneHeight)
        lanes.append(Lane(id: rid, x: x, y: y, w: w, h: h, title: r["title"]?.string ?? ""))
      default:
        break
      }
    }
    cards.sort { ($0.order, $0.card.id) < ($1.order, $1.card.id) }
    return Board(cards: cards.map(\.card), lanes: lanes.sorted { $0.id < $1.id })
  }

  /// What changed from `old` to `new`, both board `id`: whole records for new items, the changed
  /// fields of the others, and deletions. `orders` holds the order keys the store has for its cards.
  public static func changes(from old: Board, to new: Board, board id: String, orders: [String: String]) -> [String: Change] {
    var out: [String: Change] = [:]
    let keys = OrderKey.assign(new.cards.map(\.id), keeping: orders)
    let oldCards = Dictionary(old.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for c in new.cards {
      let now = card(c, board: id, order: keys[c.id]!)
      guard let was = oldCards[c.id] else {
        out[c.id] = .fields(now.fields)
        continue
      }
      let diff = changed(card(was, board: id, order: orders[c.id] ?? ""), now)
      if !diff.isEmpty { out[c.id] = .fields(diff) }
    }
    let oldLanes = Dictionary(old.lanes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for l in new.lanes {
      let now = lane(l, board: id)
      guard let was = oldLanes[l.id] else {
        out[l.id] = .fields(now.fields)
        continue
      }
      let diff = changed(lane(was, board: id), now)
      if !diff.isEmpty { out[l.id] = .fields(diff) }
    }
    let cardIDs = Set(new.cards.map(\.id)), laneIDs = Set(new.lanes.map(\.id))
    for c in old.cards where !cardIDs.contains(c.id) { out[c.id] = .deleted("card") }
    for l in old.lanes where !laneIDs.contains(l.id) { out[l.id] = .deleted("lane") }
    return out
  }

  static func changed(_ a: Record, _ b: Record) -> [String: JSONValue] { b.fields.filter { a[$0.key] != $0.value } }
}
```

`BreezyKit/Sources/BreezyKit/OrderKey.swift`:

```swift
import Foundation

/// Fractional order keys: strings of base-62 digits, compared as strings, never ending in "0", so
/// that a key fits between any two. Cards sort by key, then id, so equal keys are harmless.
public enum OrderKey {
  static let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

  public static func valid(_ key: String) -> Bool {
    !key.isEmpty && !key.hasSuffix("0") && key.allSatisfy(digits.contains)
  }

  /// A key after `a` and before `b`; "" is the start and nil the end. Needs a < b, both valid or "".
  public static func between(_ a: String, _ b: String?) -> String {
    String(midpoint(Array(a), b.map(Array.init)))
  }

  private static func midpoint(_ a: [Character], _ b: [Character]?) -> [Character] {
    if let b {
      var n = 0
      while n < b.count && (n < a.count ? a[n] : "0") == b[n] { n += 1 }
      if n > 0 { return Array(b[..<n]) + midpoint(Array(a.dropFirst(n)), Array(b.dropFirst(n))) }
    }
    let da = a.first.map(index) ?? 0
    let db = b.flatMap { $0.first.map(index) } ?? digits.count
    if db - da > 1 { return [digits[(da + db + 1) / 2]] }
    if let b, b.count > 1 { return [b[0]] }
    return [digits[da]] + midpoint(Array(a.dropFirst()), nil)
  }

  private static func index(_ c: Character) -> Int { digits.firstIndex(of: c)! }

  /// Keys for `ids` in this order: the longest run whose `keys` already increase keeps them, the
  /// others get keys between their neighbours, so a reorder rewrites as few cards as it can.
  public static func assign(_ ids: [String], keeping keys: [String: String]) -> [String: String] {
    let known = ids.map { id in keys[id].flatMap { valid($0) ? $0 : nil } }
    let kept = longestIncreasing(known)
    var out: [String: String] = [:]
    var i = 0
    while i < ids.count {
      if kept.contains(i) {
        out[ids[i]] = known[i]!
        i += 1
        continue
      }
      var j = i
      while j < ids.count && !kept.contains(j) { j += 1 }
      var lo = i > 0 ? out[ids[i - 1]]! : ""
      let hi = j < ids.count ? known[j]! : nil
      for k in i..<j {
        lo = between(lo, hi)
        out[ids[k]] = lo
      }
      i = j
    }
    return out
  }

  /// The indices of a longest strictly increasing run of the keys present.
  static func longestIncreasing(_ keys: [String?]) -> Set<Int> {
    var tails: [Int] = []
    var prev = [Int?](repeating: nil, count: keys.count)
    for (i, k) in keys.enumerated() {
      guard let k else { continue }
      var lo = 0, hi = tails.count
      while lo < hi {
        let m = (lo + hi) / 2
        if keys[tails[m]]! < k { lo = m + 1 } else { hi = m }
      }
      prev[i] = lo > 0 ? tails[lo - 1] : nil
      if lo == tails.count { tails.append(i) } else { tails[lo] = i }
    }
    var out = Set<Int>()
    var at = tails.last
    while let j = at {
      out.insert(j)
      at = prev[j]
    }
    return out
  }
}
```

In `Model.swift`, replace `newID`:

```swift
/// 16 random bytes: ids are made on every device and must not collide.
public func newID() -> String { Base64URL.encode(randomBytes(16)) }
```

In `Edits.swift` and `Format.swift`, change every `newID("c")` and `newID("l")` to `newID()`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `swift test --package-path BreezyKit`
Expected: all tests pass, the existing ones included.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit --message "Describe boards as records with order keys" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 2: Three-way merge in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Merge.swift`, `BreezyKit/Tests/Fixtures/merge.json`
- Test: `BreezyKit/Tests/BreezyKitTests/MergeTests.swift`

**Interfaces:**
- Consumes: `Record` (Task 1)
- Produces: `struct MergeResult { record: Record; copy: Record? }`, `Merge.record(base: Record?, local: Record, incoming: Record) -> MergeResult`

- [ ] **Step 1: Add the shared merge cases**

`BreezyKit/Tests/Fixtures/merge.json`:

```json
[
  {
    "name": "a field changed here only stays",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": null
  },
  {
    "name": "a field changed there only comes in",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 3, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 3, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": null
  },
  {
    "name": "changes to different fields combine",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 3, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 3, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": null
  },
  {
    "name": "the same change on both sides is no conflict",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": null
  },
  {
    "name": "text changed on both sides makes a copy",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 2, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "c", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "c", "notes": "", "color": 2, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 2, "pos": [24, 24], "w": 240, "order": "V" }
  },
  {
    "name": "notes changed on both sides make a copy",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "x", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "y", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "y", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "copy": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "x", "color": 1, "pos": [24, 24], "w": 240, "order": "V" }
  },
  {
    "name": "other fields changed on both sides take the server's",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [24, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [48, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [48, 0], "w": 240, "order": "V" },
    "copy": null
  },
  {
    "name": "a delete there wins",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 2, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "deleted": true },
    "record": { "format": 1, "kind": "card", "deleted": true },
    "copy": null
  },
  {
    "name": "a delete there keeps text changed here as a copy",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "deleted": true },
    "record": { "format": 1, "kind": "card", "deleted": true },
    "copy": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [24, 24], "w": 240, "order": "V" }
  },
  {
    "name": "a delete here keeps text changed there as a copy",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "deleted": true },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "c", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "record": { "format": 1, "kind": "card", "deleted": true },
    "copy": { "format": 1, "kind": "card", "board": "B", "text": "c", "notes": "", "color": 1, "pos": [24, 24], "w": 240, "order": "V" }
  },
  {
    "name": "fields this version does not know are kept",
    "base": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "local": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V" },
    "incoming": { "format": 1, "kind": "card", "board": "B", "text": "a", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V", "tag": "x" },
    "record": { "format": 1, "kind": "card", "board": "B", "text": "b", "notes": "", "color": 1, "pos": [0, 0], "w": 240, "order": "V", "tag": "x" },
    "copy": null
  },
  {
    "name": "a lane title changed on both sides takes the server's",
    "base": { "format": 1, "kind": "lane", "board": "B", "title": "Doing", "pos": [0, 0], "size": [480, 720] },
    "local": { "format": 1, "kind": "lane", "board": "B", "title": "Now", "pos": [0, 0], "size": [480, 720] },
    "incoming": { "format": 1, "kind": "lane", "board": "B", "title": "Later", "pos": [0, 0], "size": [480, 720] },
    "record": { "format": 1, "kind": "lane", "board": "B", "title": "Later", "pos": [0, 0], "size": [480, 720] },
    "copy": null
  },
  {
    "name": "with no base the server's title wins",
    "base": null,
    "local": { "format": 1, "kind": "board", "title": "Mine" },
    "incoming": { "format": 1, "kind": "board", "title": "Theirs" },
    "record": { "format": 1, "kind": "board", "title": "Theirs" },
    "copy": null
  }
]
```

- [ ] **Step 2: Write the failing test**

`BreezyKit/Tests/BreezyKitTests/MergeTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

private struct MergeCase: Decodable {
  var name: String
  var base: Record?
  var local: Record
  var incoming: Record
  var record: Record
  var copy: Record?
}

@Test func mergesMatchTheSharedCases() throws {
  for c in try JSONDecoder().decode([MergeCase].self, from: fixture("merge.json")) {
    let r = Merge.record(base: c.base, local: c.local, incoming: c.incoming)
    #expect(r.record == c.record, "\(c.name)")
    #expect(r.copy == c.copy, "\(c.name)")
  }
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `swift test --package-path BreezyKit --filter mergesMatch`
Expected: build failure, `cannot find 'Merge' in scope`.

- [ ] **Step 4: Write the implementation**

`BreezyKit/Sources/BreezyKit/Merge.swift`:

```swift
import Foundation

public struct MergeResult: Equatable, Sendable {
  public var record: Record
  /// A new card keeping text that would otherwise be lost.
  public var copy: Record?
}

/// Three-way merge of one record: `base` as last pulled, `local` as this device has it, `incoming`
/// from the server. Each field takes the side that changed it, the server's when both did; text
/// or notes both sides changed differently, or changed on one side and deleted on the other, go
/// into a copy card so that nothing typed is lost.
public enum Merge {
  static let texts = ["text", "notes"]

  public static func record(base: Record?, local: Record, incoming: Record) -> MergeResult {
    let base = base ?? Record([:])
    if incoming.deleted || local.deleted {
      let survivor = incoming.deleted ? (local.deleted ? nil : local) : incoming
      let marker = incoming.deleted ? incoming : local
      guard let s = survivor, texts.contains(where: { s[$0] != base[$0] }) else { return MergeResult(record: marker, copy: nil) }
      return MergeResult(record: marker, copy: copy(of: s))
    }
    var out: [String: JSONValue] = [:]
    var conflict = false
    for key in Set(base.fields.keys).union(local.fields.keys).union(incoming.fields.keys) {
      let b = base[key], l = local[key], i = incoming[key]
      if l == b {
        out[key] = i
      } else if i == b || i == l {
        out[key] = l
      } else {
        out[key] = i
        if texts.contains(key) { conflict = true }
      }
    }
    return MergeResult(record: Record(out), copy: conflict ? copy(of: local) : nil)
  }

  /// `r` 24 pt right of and below where it was.
  static func copy(of r: Record) -> Record {
    var c = r
    if let (x, y) = Records.unpair(r["pos"]) { c["pos"] = Records.pair(x + 24, y + 24) }
    return c
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit --message "Merge records three ways, keeping conflicting text as a copy" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 3: Undo that leaves the other device's changes alone, in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Rebase.swift`
- Modify: `BreezyKit/Sources/BreezyKit/BoardModel.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/RebaseTests.swift`, `BoardModelTests.swift` (append)

**Interfaces:**
- Produces: `Board.rebase(base: Board, mine: Board, theirs: Board) -> Board`
- Produces: `BoardModel.applyRemote(_ new: Board)`, `BoardModel.onEdit: (() -> Void)?`, `BoardModel.onGestureEnd: (() -> Void)?`

- [ ] **Step 1: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/RebaseTests.swift`:

```swift
import Testing
@testable import BreezyKit

@Test func rebaseTakesMyChangesOntoTheirs() {
  let base = board([card("a", 0, 0, "x")])
  var mine = base
  mine.setColor(["a"], 3)
  var theirs = base
  theirs.setText("a", "y")
  let r = Board.rebase(base: base, mine: mine, theirs: theirs)
  #expect(r.card("a")!.color == 3 && r.card("a")!.text == "y")
}

@Test func rebaseLetsTheirsWinAFieldBothChanged() {
  let base = board([card("a", 0, 0)])
  var mine = base
  mine.setColor(["a"], 3)
  var theirs = base
  theirs.setColor(["a"], 4)
  #expect(Board.rebase(base: base, mine: mine, theirs: theirs).card("a")!.color == 4)
}

@Test func rebaseRemovesWhatIRemovedUnlessTheyChangedIt() {
  let base = board([card("a", 0, 0), card("b", 0, 0)], [lane("l", 0, 0)])
  var theirs = base
  theirs.setText("b", "kept")
  let r = Board.rebase(base: base, mine: Board(), theirs: theirs)
  #expect(r.cards.map(\.id) == ["b"])
  #expect(r.lanes.isEmpty)
}

@Test func rebaseKeepsWhatTheyAddedAndTheOrderIChose() {
  let base = board([card("a", 0, 0), card("b", 0, 0)])
  let mine = board([card("b", 0, 0), card("a", 0, 0)])
  var theirs = base
  theirs.cards.append(card("c", 0, 0))
  #expect(Board.rebase(base: base, mine: mine, theirs: theirs).cards.map(\.id) == ["b", "a", "c"])
}

@Test func rebaseBringsBackWhatIAdded() {
  let base = board([card("a", 0, 0)])
  let mine = board([card("a", 0, 0), card("n", 0, 96)])
  #expect(Board.rebase(base: base, mine: mine, theirs: base).cards.map(\.id) == ["a", "n"])
}
```

Append to `BreezyKit/Tests/BreezyKitTests/BoardModelTests.swift`:

```swift
@Test func undoLeavesChangesFromAnotherDeviceAlone() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  var remote = m.board
  remote.moveCards([Origin(id: "a", x: 0, y: 0)], dx: 48, dy: 0)
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card("a")!.color == 1)
  #expect(m.board.card("a")!.x == 48)
}

@Test func undoKeepsAFieldTheOtherDeviceChangedSince() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  var remote = m.board
  remote.setColor(["a"], 4)
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card("a")!.color == 4)
}

@Test func redoPutsBackOnlyWhatTheStepChanged() {
  let m = BoardModel(board: board([card("a", 0, 0, "x")]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  m.undoManager.undo()
  var remote = m.board
  remote.setText("a", "y")
  m.applyRemote(remote)
  m.undoManager.redo()
  #expect(m.board.card("a")!.color == 3 && m.board.card("a")!.text == "y")
}

@Test func undoingANewCardKeepsItWhenTheOtherDeviceTypedInIt() {
  let m = BoardModel()
  var id = ""
  m.perform("New Card") { id = $0.addCard(x: 0, y: 0) }
  var remote = m.board
  remote.setText(id, "theirs")
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card(id)?.text == "theirs")
}

@Test func changesFromAnotherDeviceAddNoUndoStep() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var remote = m.board
  remote.setColor(["a"], 2)
  var heard = 0
  m.onEdit = { heard += 1 }
  m.applyRemote(remote)
  #expect(m.board == remote)
  #expect(!m.undoManager.canUndo)
  #expect(heard == 1)
}

@Test func changesFromAnotherDeviceWaitForAGesture() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.begin()
  m.update { $0.setText("a", "typing") }
  var remote = m.board
  remote.setColor(["a"], 2)
  m.applyRemote(remote)
  #expect(m.board.card("a")!.color == 1)
}

@Test func theEndOfAGestureIsHeard() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var ended = 0
  m.onGestureEnd = { ended += 1 }
  m.begin()
  m.update { $0.setText("a", "typed") }
  m.end("Edit Card")
  #expect(ended == 1)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter 'rebase|undo|redo|AnotherDevice|Gesture'`
Expected: build failure, `type 'Board' has no member 'rebase'`.

- [ ] **Step 3: Write `Rebase.swift`**

```swift
import Foundation

extension Board {
  /// `mine`'s changes since `base`, made to `theirs` field by field; where `theirs` changed a field
  /// too, `theirs` wins. Undo uses it so that a step back leaves changes from another device alone.
  public static func rebase(base: Board, mine: Board, theirs: Board) -> Board {
    func pick<T: Equatable>(_ b: T, _ m: T, _ t: T) -> T { t == b ? m : t }
    func card(_ b: Card?, _ m: Card?, _ t: Card?) -> Card? {
      switch (b, m, t) {
      case let (b?, m?, t?):
        var c = t
        if t.x == b.x && t.y == b.y {
          c.x = m.x
          c.y = m.y
        }
        c.w = pick(b.w, m.w, t.w)
        c.text = pick(b.text, m.text, t.text)
        c.notes = pick(b.notes, m.notes, t.notes)
        c.color = pick(b.color, m.color, t.color)
        return c
      case let (b?, nil, t?): return t == b ? nil : t
      case (_?, _, nil): return nil
      case let (nil, m?, nil): return m
      case let (nil, _, t?): return t
      case (nil, nil, nil): return nil
      }
    }
    func lane(_ b: Lane?, _ m: Lane?, _ t: Lane?) -> Lane? {
      switch (b, m, t) {
      case let (b?, m?, t?):
        var l = t
        if t.x == b.x && t.y == b.y {
          l.x = m.x
          l.y = m.y
        }
        if t.w == b.w && t.h == b.h {
          l.w = m.w
          l.h = m.h
        }
        l.title = pick(b.title, m.title, t.title)
        return l
      case let (b?, nil, t?): return t == b ? nil : t
      case (_?, _, nil): return nil
      case let (nil, m?, nil): return m
      case let (nil, _, t?): return t
      case (nil, nil, nil): return nil
      }
    }
    func byID<T: Identifiable>(_ xs: [T]) -> [T.ID: T] { Dictionary(xs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }

    let bc = byID(base.cards), mc = byID(mine.cards), tc = byID(theirs.cards)
    var cards: [String: Card] = [:]
    for id in Set(bc.keys).union(mc.keys).union(tc.keys) { cards[id] = card(bc[id], mc[id], tc[id]) }
    let mineIDs = mine.cards.map(\.id), baseIDs = base.cards.map(\.id), theirIDs = theirs.cards.map(\.id)
    let common = Set(mineIDs).intersection(baseIDs)
    let reordered = mineIDs.filter(common.contains) != baseIDs.filter(common.contains)
    let cardOrder = arrange(Set(cards.keys), primary: reordered ? mineIDs : theirIDs, other: reordered ? theirIDs : mineIDs)

    let bl = byID(base.lanes), ml = byID(mine.lanes), tl = byID(theirs.lanes)
    var lanes: [String: Lane] = [:]
    for id in Set(bl.keys).union(ml.keys).union(tl.keys) { lanes[id] = lane(bl[id], ml[id], tl[id]) }
    let laneOrder = arrange(Set(lanes.keys), primary: theirs.lanes.map(\.id), other: mine.lanes.map(\.id))

    return Board(cards: cardOrder.map { cards[$0]! }, lanes: laneOrder.map { lanes[$0]! })
  }

  /// `keep` in `primary`'s order; the rest follow what came before them in `other`.
  static func arrange(_ keep: Set<String>, primary: [String], other: [String]) -> [String] {
    var out = primary.filter(keep.contains)
    var placed = Set(out)
    var last = -1
    for id in other where keep.contains(id) {
      if placed.contains(id) {
        last = max(last, out.firstIndex(of: id)!)
        continue
      }
      last += 1
      out.insert(id, at: last)
      placed.insert(id)
    }
    return out
  }
}
```

- [ ] **Step 4: Change `BoardModel.swift`**

Add below `onPending`:

```swift
  /// Called after every change too, undo, redo and `applyRemote` included: a second listener.
  public var onEdit: (() -> Void)?
  /// Called when a gesture ends or is cancelled.
  public var onGestureEnd: (() -> Void)?
```

Replace every `onChange?(x)` call in the class with `notify(x)` and add:

```swift
  private func notify(_ before: Board) {
    onChange?(before)
    onEdit?()
  }

  /// Puts in changes from another device, without an undo step; the steps already taken still undo
  /// only what they changed. Does nothing during a gesture: the caller waits for it to end.
  public func applyRemote(_ new: Board) {
    guard !inGesture, new != board else { return }
    let before = board
    board = new
    notify(before)
  }
```

Replace `cancelGesture`, `record` and `restore`:

```swift
  private func cancelGesture() {
    let ended = gestureStart != nil
    gestureStart = nil
    if pending {
      pending = false
      onPending?(false)
    }
    if ended { onGestureEnd?() }
  }

  private func record(_ before: Board, _ name: String) {
    guard board != before else { return }
    let after = board
    undoManager.beginUndoGrouping()
    undoManager.registerUndo(withTarget: self) { $0.restore(from: after, to: before, name) }
    undoManager.setActionName(name)
    undoManager.endUndoGrouping()
  }

  /// Takes the board from `from` to `to` field by field, leaving what changed since alone.
  private func restore(from: Board, to: Board, _ name: String) {
    let now = board
    cancelGesture()
    undoManager.registerUndo(withTarget: self) { $0.restore(from: to, to: from, name) }
    undoManager.setActionName(name)
    board = Board.rebase(base: from, mine: to, theirs: now)
    notify(now)
  }
```

Update the class doc comment: after "registers one undo step, and only when the board changed." add " A step undoes field by field, so changes from another device made since stay."

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass. If the compiler calls a `switch` in `rebase` non-exhaustive, the cases above cover every combination; reorder the patterns rather than adding `default`.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit --message "Undo field by field, leaving changes from another device alone" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 4: Keys, blobs and invites in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/SpaceKeys.swift`, `BreezyKit/Tests/Fixtures/crypto.json`
- Test: `BreezyKit/Tests/BreezyKitTests/CryptoTests.swift`

**Interfaces:**
- Consumes: `Base64URL`, `randomBytes` (Task 1)
- Produces: `struct SpaceKeys { space: Data; token: Data; init(space: Data, secret: Data); seal(_ plaintext: Data, id: Data, nonce: AES.GCM.Nonce = .init()) throws -> Data; open(_ blob: Data, id: Data) throws -> Data }`
- Produces: `struct Invite: Codable, Equatable { server, space, secret: String; var link: String; init?(link: String); static func validServer(_:) -> Bool; static let prefix }`
- Task 5 adds `SpaceKeys.init(state:)`.

- [ ] **Step 1: Add the vector**

The values below were computed with WebCrypto and checked against CryptoKit. `BreezyKit/Tests/Fixtures/crypto.json`:

```json
{
  "secret": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "space": "QEFCQ0RFRkdISUpLTE1OTw",
  "id": "YGFiY2RlZmdoaWprbG1ubw",
  "nonce": "gIGCg4SFhoeIiYqL",
  "plaintext": "{\"format\":1,\"kind\":\"board\",\"title\":\"Plans\"}",
  "token": "zkIWReSOCPzlBul9zmJo3zsGBFXz1dZ4r_t5nYATtQI",
  "tokenHash": "qd466AWYMss8t8tSy4czk3Fo4ObWyeht6QEO6mMSklc",
  "blob": "gIGCg4SFhoeIiYqLCD5NiFc_mM3evpb5SgXl1WlqsBtw62Y1OYQb9SzevkGzUHB47Zw8yJBM4ytZJ5_CIRjBsT1s26zV7TY",
  "server": "https://example.com/breezy/sync.php",
  "invite": "https://arlol.github.io/breezy/#join=eyJzZWNyZXQiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4Iiwic2VydmVyIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9icmVlenkvc3luYy5waHAiLCJzcGFjZSI6IlFFRkNRMFJGUmtkSVNVcExURTFPVHcifQ"
}
```

- [ ] **Step 2: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/CryptoTests.swift`:

```swift
import CryptoKit
import Foundation
import Testing
@testable import BreezyKit

private struct Vector: Decodable {
  var secret, space, id, nonce, plaintext, token, tokenHash, blob, server, invite: String
}

private func vector() throws -> Vector { try JSONDecoder().decode(Vector.self, from: fixture("crypto.json")) }

@Test func encryptionMatchesTheSharedVector() throws {
  let v = try vector()
  let keys = SpaceKeys(space: Base64URL.decode(v.space)!, secret: Base64URL.decode(v.secret)!)
  let id = Base64URL.decode(v.id)!
  #expect(Base64URL.encode(keys.token) == v.token)
  #expect(Base64URL.encode(Data(SHA256.hash(data: keys.token))) == v.tokenHash)
  let sealed = try keys.seal(Data(v.plaintext.utf8), id: id, nonce: AES.GCM.Nonce(data: Base64URL.decode(v.nonce)!))
  #expect(Base64URL.encode(sealed) == v.blob)
  #expect(try keys.open(Base64URL.decode(v.blob)!, id: id) == Data(v.plaintext.utf8))
}

@Test func aBlobMovedToAnotherRecordDoesNotOpen() throws {
  let keys = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  let blob = try keys.seal(Data("x".utf8), id: randomBytes(16))
  #expect(throws: (any Error).self) { try keys.open(blob, id: randomBytes(16)) }
}

@Test func invitesGoToLinksAndBack() throws {
  let v = try vector()
  let invite = Invite(link: v.invite)
  #expect(invite == Invite(server: v.server, space: v.space, secret: v.secret))
  #expect(Invite(link: invite!.link) == invite)
  #expect(invite!.link.hasPrefix(Invite.prefix))
}

@Test func aPastedInviteMayHaveTextAroundIt() throws {
  let v = try vector()
  #expect(Invite(link: "Join me: \(v.invite)).\n") == Invite(server: v.server, space: v.space, secret: v.secret))
}

@Test func whatIsNotAnInviteIsRefused() throws {
  let v = try vector()
  for text in [
    "", "https://arlol.github.io/breezy/", "https://arlol.github.io/breezy/#join=abc",
    Invite(server: "ftp://example.com", space: v.space, secret: v.secret).link,
    Invite(server: v.server, space: "AAAA", secret: v.secret).link,
    Invite(server: v.server, space: v.space, secret: "AAAA").link,
  ] {
    #expect(Invite(link: text) == nil, "\(text)")
  }
}

@Test func serversMustBeHTTPSOrThisComputer() {
  #expect(Invite.validServer("https://example.com/breezy/sync.php"))
  #expect(Invite.validServer("http://localhost:58566/sync.php"))
  #expect(Invite.validServer("http://127.0.0.1:58566/sync.php"))
  #expect(!Invite.validServer("http://example.com/sync.php"))
  #expect(!Invite.validServer("example.com"))
  #expect(!Invite.validServer(""))
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter 'encryption|Blob|nvite|servers'`
Expected: build failure, `cannot find 'SpaceKeys' in scope`.

- [ ] **Step 4: Write `SpaceKeys.swift`**

```swift
import CryptoKit
import Foundation

/// What a space's secret gives: the key that seals records and the token the server checks.
public struct SpaceKeys {
  public let space: Data
  public let token: Data
  let key: SymmetricKey

  public init(space: Data, secret: Data) {
    let ikm = SymmetricKey(data: secret)
    func derive(_ info: String) -> SymmetricKey {
      HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data(info.utf8), outputByteCount: 32)
    }
    self.space = space
    key = derive("breezy key")
    token = derive("breezy token").withUnsafeBytes { Data($0) }
  }

  /// Nonce, ciphertext and tag; the space and record ids are bound in, so the blob opens nowhere else.
  public func seal(_ plaintext: Data, id: Data, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> Data {
    try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: space + id).combined!
  }

  public func open(_ blob: Data, id: Data) throws -> Data {
    try AES.GCM.open(AES.GCM.SealedBox(combined: blob), using: key, authenticating: space + id)
  }
}

/// What joins a device to a space: the server, the space and its secret, as a link.
public struct Invite: Codable, Equatable, Sendable {
  public static let prefix = "https://arlol.github.io/breezy/#join="
  public var server: String
  public var space: String
  public var secret: String

  public init(server: String, space: String, secret: String) {
    self.server = server
    self.space = space
    self.secret = secret
  }

  public var link: String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return Self.prefix + Base64URL.encode(try! e.encode(self))
  }

  /// The invite in pasted text, which may hold more than the link.
  public init?(link text: String) {
    guard let r = text.range(of: "#join=") else { return nil }
    let token = String(text[r.upperBound...].prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    guard let data = Base64URL.decode(token), let i = try? JSONDecoder().decode(Invite.self, from: data),
          Self.validServer(i.server), Base64URL.decode(i.space)?.count == 16, Base64URL.decode(i.secret)?.count == 32
    else { return nil }
    self = i
  }

  /// HTTPS, or plain HTTP to this computer for trying the server out.
  public static func validServer(_ s: String) -> Bool {
    guard let u = URL(string: s), let host = u.host, !host.isEmpty else { return false }
    return u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit --message "Derive a space's key and token and encode invites" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 5: The store and its file in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Store.swift`
- Modify: `BreezyKit/Sources/BreezyKit/SpaceKeys.swift` (add `init(state:)`)
- Test: `BreezyKit/Tests/BreezyKitTests/StoreTests.swift`

**Interfaces:**
- Consumes: `Record`, `Change`, `Records`, `Merge`, `Invite`, `newID`, `randomBytes`
- Produces: `struct StoredRecord { base: Record?; version: Int; current: Record; pending: Bool }`, `struct Held { version: Int; blob: String }`
- Produces: `struct SpaceState: Codable { server, space, secret: String?; cursor: Int; records: [String: StoredRecord]; held: [String: Held]; unreadable: Int; invite: Invite? }`
- Produces: `struct Incoming { id: String; version: Int; record: Record }`
- Produces: `final class Store { state; onChange: ((Set<String>, Bool) -> Void)?; onDirty: (() -> Void)?; boards: [(id: String, title: String)]; title(of:) -> String?; board(_:) -> Board; createBoard(title:contents:) -> String; renameBoard(_:_:); deleteBoard(_:); apply(_:); orders(of:) -> [String: String]; pending: [(id: String, base: Int, record: Record)]; accepted(_:version:record:); merge(_ items: [Incoming]); advance(to:); hold(_:version:blob:); release(_:); noteUnreadable(); join(_:); startSyncing(server:) -> Invite }`
- Produces: `final class StoreFile { url; onError; init(url:); load() throws -> SpaceState?; scheduleSave(_ state: @escaping () -> SpaceState); save(_:wait:) }`
- Produces: `SpaceKeys.init(state: SpaceState) throws`

- [ ] **Step 1: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/StoreTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

/// As if every pending record had been pushed and taken at `version`.
func settle(_ s: Store, version: Int = 1) {
  for p in s.pending { s.accepted(p.id, version: version, record: p.record) }
}

@Test func aNewBoardWaitsToBePushed() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  #expect(s.boards.map(\.title) == ["Plans"])
  #expect(s.title(of: id) == "Plans")
  #expect(s.board(id) == board([card("c", 0, 0)]))
  #expect(Set(s.pending.map(\.id)) == [id, "c"])
}

@Test func acceptedRecordsStopWaitingUnlessChangedSince() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  let sent = s.pending
  s.apply(["c": .fields(["color": .number(2)])])
  for p in sent { s.accepted(p.id, version: 1, record: p.record) }
  #expect(s.pending.map(\.id) == ["c"])
  #expect(s.state.records[id]!.version == 1)
}

@Test func aMergeComesInWhereNothingWaits() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  var r = s.state.records["c"]!.current
  r["text"] = .string("theirs")
  var heard: [(Set<String>, Bool)] = []
  s.onChange = { heard.append(($0, $1)) }
  s.merge([Incoming(id: "c", version: 2, record: r)])
  #expect(s.board(id).card("c")!.text == "theirs")
  #expect(s.pending.isEmpty)
  #expect(heard.count == 1 && heard[0].0 == [id] && heard[0].1)
}

@Test func anOlderVersionIsIgnored() {
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "now")]))
  settle(s, version: 5)
  var r = s.state.records["c"]!.current
  r["text"] = .string("old")
  s.merge([Incoming(id: "c", version: 4, record: r)])
  #expect(s.state.records["c"]!.current["text"] == .string("now"))
}

@Test func editsAndMergesCombineFieldByField() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "x")]))
  settle(s)
  s.apply(["c": .fields(["color": .number(3)])])
  var r = s.state.records["c"]!.base!
  r["text"] = .string("theirs")
  s.merge([Incoming(id: "c", version: 2, record: r)])
  let c = s.board(id).card("c")!
  #expect(c.color == 3 && c.text == "theirs")
  #expect(s.pending.map(\.id) == ["c"])
}

@Test func aTextConflictAddsACopyCard() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "x")]))
  settle(s)
  s.apply(["c": .fields(["text": .string("mine")])])
  var r = s.state.records["c"]!.base!
  r["text"] = .string("theirs")
  s.merge([Incoming(id: "c", version: 2, record: r)])
  #expect(s.board(id).cards.map(\.text).sorted() == ["mine", "theirs"])
}

@Test func editsToADeletedRecordAreDropped() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  s.merge([Incoming(id: "c", version: 2, record: .marker("card"))])
  s.apply(["c": .fields(["color": .number(3)])])
  #expect(s.board(id).cards.isEmpty)
  #expect(s.state.records["c"]!.current.deleted)
}

@Test func deletingABoardDeletesWhatIsOnIt() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)], [lane("l", 0, 0)]))
  s.deleteBoard(id)
  #expect(s.boards.isEmpty)
  #expect(s.title(of: id) == nil)
  #expect(["c", "l", id].allSatisfy { s.state.records[$0]!.current.deleted })
}

@Test func renamingABoardChangesOnlyItsTitle() {
  let s = Store()
  let id = s.createBoard(title: "Plans")
  s.renameBoard(id, "Ideas")
  #expect(s.boards.map(\.title) == ["Ideas"])
}

@Test func joiningReplacesTheBoardsHere() {
  let s = Store()
  _ = s.createBoard(title: "Mine")
  let invite = Invite(server: "https://example.com/sync.php", space: Base64URL.encode(randomBytes(16)), secret: Base64URL.encode(randomBytes(32)))
  s.join(invite)
  #expect(s.boards.isEmpty)
  #expect(s.state.invite == invite)
  #expect(s.state.cursor == 0)
}

@Test func startingToSyncPushesEverything() throws {
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  let invite = s.startSyncing(server: "https://example.com/sync.php")
  #expect(s.state.invite == invite)
  #expect(s.pending.count == 2 && s.pending.allSatisfy { $0.base == 0 })
  #expect(try SpaceKeys(state: s.state).space.count == 16)
}

@Test func theStateSurvivesItsFile() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let file = StoreFile(url: dir.appendingPathComponent("space.json"))
  #expect(try file.load() == nil)
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "Kept")]))
  file.save(s.state, wait: true)
  #expect(try file.load() == s.state)
  let mode = try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? Int
  #expect(mode == 0o600)
}

@Test func saveCanWaitForTheWrite() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let file = StoreFile(url: dir.appendingPathComponent("space.json"))
  let s = Store()
  _ = s.createBoard(title: "First")
  file.save(s.state)
  _ = s.createBoard(title: "Second")
  file.save(s.state, wait: true)
  #expect(try file.load()?.records.count == 2)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter Store`
Expected: build failure, `cannot find 'Store' in scope`.

- [ ] **Step 3: Write `Store.swift`**

```swift
import Foundation

public struct StoredRecord: Codable, Equatable, Sendable {
  /// As last pulled or pushed; nil until the server has it.
  public var base: Record?
  public var version: Int
  /// As this device has it.
  public var current: Record
  public var pending: Bool { current != base }
}

/// A record from a newer Breezy, kept to be read once this one is updated.
public struct Held: Codable, Equatable, Sendable {
  public var version: Int
  public var blob: String
}

/// Everything a device keeps of its space.
public struct SpaceState: Codable, Equatable, Sendable {
  public var server: String?
  public var space: String?
  public var secret: String?
  public var cursor = 0
  public var records: [String: StoredRecord] = [:]
  public var held: [String: Held] = [:]
  public var unreadable = 0

  public init() {}

  public var invite: Invite? {
    guard let server, let space, let secret else { return nil }
    return Invite(server: server, space: space, secret: secret)
  }
}

public struct Incoming: Equatable, Sendable {
  public var id: String
  public var version: Int
  public var record: Record
}

/// The boards of one space as this device has them. Local edits come through `apply` and the
/// board methods; the server's records through `merge` and `accepted`.
public final class Store {
  public private(set) var state: SpaceState
  /// After a change to what boards show, with the boards concerned and whether it came from the server.
  public var onChange: ((_ boards: Set<String>, _ remote: Bool) -> Void)?
  /// After any change, for saving.
  public var onDirty: (() -> Void)?

  public init(state: SpaceState = SpaceState()) { self.state = state }

  public var boards: [(id: String, title: String)] {
    state.records.compactMap { id, s in
      s.current.kind == "board" && !s.current.deleted ? (id, s.current["title"]?.string ?? "") : nil
    }.sorted { $0.title == $1.title ? $0.id < $1.id : $0.title.localizedStandardCompare($1.title) == .orderedAscending }
  }

  public func title(of id: String) -> String? {
    guard let r = state.records[id]?.current, r.kind == "board", !r.deleted else { return nil }
    return r["title"]?.string ?? ""
  }

  public func board(_ id: String) -> Board { Records.board(id, from: state.records.mapValues(\.current)) }

  @discardableResult
  public func createBoard(title: String, contents: Board = Board()) -> String {
    let id = newID()
    var changes = Records.changes(from: Board(), to: contents, board: id, orders: [:])
    changes[id] = .fields(Records.board(title: title).fields)
    apply(changes)
    return id
  }

  public func renameBoard(_ id: String, _ title: String) { apply([id: .fields(["title": .string(title)])]) }

  public func deleteBoard(_ id: String) {
    var changes: [String: Change] = [id: .deleted("board")]
    for (rid, s) in state.records where s.current.board == id && !s.current.deleted { changes[rid] = .deleted(s.current.kind ?? "card") }
    apply(changes)
  }

  /// Local edits. A deleted record stays deleted; partial fields for an unknown record are dropped.
  public func apply(_ changes: [String: Change]) {
    var boards = Set<String>()
    for (id, change) in changes {
      switch change {
      case .deleted(let kind):
        guard var s = state.records[id], !s.current.deleted else { continue }
        boards.insert(s.current.board ?? id)
        s.current = .marker(kind)
        state.records[id] = s
      case .fields(let f):
        if var s = state.records[id] {
          guard !s.current.deleted else { continue }
          s.current.fields.merge(f) { _, new in new }
          state.records[id] = s
          boards.insert(s.current.board ?? id)
        } else {
          guard f["kind"] != nil else { continue }
          state.records[id] = StoredRecord(base: nil, version: 0, current: Record(f))
          boards.insert(f["board"]?.string ?? id)
        }
      }
    }
    guard !boards.isEmpty else { return }
    onDirty?()
    onChange?(boards, false)
  }

  public func orders(of board: String) -> [String: String] {
    var out: [String: String] = [:]
    for (id, s) in state.records where s.current.kind == "card" && !s.current.deleted && s.current.board == board {
      if let o = s.current["order"]?.string { out[id] = o }
    }
    return out
  }

  public var pending: [(id: String, base: Int, record: Record)] {
    state.records.compactMap { id, s in s.pending ? (id, s.version, s.current) : nil }.sorted { $0.id < $1.id }
  }

  /// The server took `record` as `version`; edits made since it was sent stay pending.
  public func accepted(_ id: String, version: Int, record: Record) {
    guard var s = state.records[id] else { return }
    s.base = record
    s.version = version
    state.records[id] = s
    onDirty?()
  }

  /// Records from the server, merged three ways into those with local changes.
  public func merge(_ items: [Incoming]) {
    guard !items.isEmpty else { return }
    var boards = Set<String>()
    for item in items {
      let old = state.records[item.id]
      if let old, item.version <= old.version { continue }
      var current = item.record
      if let old, old.pending {
        let m = Merge.record(base: old.base, local: old.current, incoming: item.record)
        current = m.record
        if let copy = m.copy { state.records[newID()] = StoredRecord(base: nil, version: 0, current: copy) }
      }
      boards.formUnion([old?.current.board, current.board, item.record.board].compactMap { $0 })
      if item.record.kind == "board" { boards.insert(item.id) }
      state.records[item.id] = StoredRecord(base: item.record, version: item.version, current: current)
    }
    onDirty?()
    if !boards.isEmpty { onChange?(boards, true) }
  }

  public func advance(to cursor: Int) {
    state.cursor = max(state.cursor, cursor)
    onDirty?()
  }

  public func hold(_ id: String, version: Int, blob: String) {
    state.held[id] = Held(version: version, blob: blob)
    onDirty?()
  }

  public func release(_ id: String) {
    state.held[id] = nil
    onDirty?()
  }

  public func noteUnreadable() {
    state.unreadable += 1
    onDirty?()
  }

  /// This device's boards give way to the space `invite` names.
  public func join(_ invite: Invite) {
    let boards = Set(self.boards.map(\.id))
    state = SpaceState()
    state.server = invite.server
    state.space = invite.space
    state.secret = invite.secret
    onDirty?()
    onChange?(boards, true)
  }

  /// A new space on `server` for the boards here; every record waits to be pushed.
  @discardableResult
  public func startSyncing(server: String) -> Invite {
    state.server = server
    state.space = Base64URL.encode(randomBytes(16))
    state.secret = Base64URL.encode(randomBytes(32))
    state.cursor = 0
    state.held = [:]
    state.unreadable = 0
    for id in state.records.keys {
      state.records[id]!.base = nil
      state.records[id]!.version = 0
    }
    onDirty?()
    return state.invite!
  }
}

/// The store on disk: JSON, written atomically off the main thread, readable only by its owner.
public final class StoreFile {
  public let url: URL
  public var onError: ((Error) -> Void)?
  private let queue = DispatchQueue(label: "breezy.store-file")
  private var scheduled = false

  public init(url: URL) { self.url = url }

  public func load() throws -> SpaceState? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(SpaceState.self, from: Data(contentsOf: url))
  }

  /// Saves `state()` half a second from now, once however often it is asked meanwhile.
  public func scheduleSave(_ state: @escaping () -> SpaceState) {
    guard !scheduled else { return }
    scheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self else { return }
      scheduled = false
      save(state())
    }
  }

  /// With `wait`, returns once this and every earlier save are on disk.
  public func save(_ state: SpaceState, wait: Bool = false) {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    let data: Data
    do {
      data = try e.encode(state)
    } catch {
      onError?(error)
      return
    }
    let url = url
    let write = { [weak self] in
      do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      } catch {
        DispatchQueue.main.async { self?.onError?(error) }
      }
    }
    if wait { queue.sync(execute: write) } else { queue.async(execute: write) }
  }
}
```

Append to `SpaceKeys` in `SpaceKeys.swift`:

```swift
extension SpaceKeys {
  struct NotSyncing: Error {}

  public init(state: SpaceState) throws {
    guard let invite = state.invite, let space = Base64URL.decode(invite.space), space.count == 16,
          let secret = Base64URL.decode(invite.secret), secret.count == 32 else { throw NotSyncing() }
    self.init(space: space, secret: secret)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add BreezyKit
git commit --message "Keep a space's records in a store with its file" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 6: A board's binding to the store in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/BoardBinding.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/BoardBindingTests.swift`

**Interfaces:**
- Consumes: `BoardModel.applyRemote/onEdit/onGestureEnd` (Task 3), `Store` (Task 5), `Records.changes`
- Produces: `final class BoardBinding { id; model; store; restack: ((inout Board) -> Void)?; init(id:model:store:); changed(); flush(); pull() }`

- [ ] **Step 1: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/BoardBindingTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

@MainActor private func opened(_ contents: Board) -> (Store, String, BoardModel, BoardBinding) {
  let store = Store()
  let id = store.createBoard(title: "B", contents: contents)
  settle(store)
  let model = BoardModel(board: store.board(id))
  return (store, id, model, BoardBinding(id: id, model: model, store: store))
}

@MainActor @Test func aMergeDuringAGestureWaitsAndKeepsTheTypedText() async throws {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  model.begin()
  model.update { $0.setText("a", "typed") }
  store.merge([Incoming(id: "n", version: 2, record: Records.card(card("n", 0, 96, "new"), board: id, order: "z"))])
  binding.pull()
  #expect(model.board.card("n") == nil)
  model.end("Edit Card")
  try await Task.sleep(for: .milliseconds(50))
  #expect(model.board.card("n")?.text == "new")
  #expect(model.board.card("a")?.text == "typed")
  #expect(store.board(id).card("a")?.text == "typed")
  #expect(model.undoManager.undoActionName == "Edit Card")
}

@MainActor @Test func restackingAMergeIsShownButNotWritten() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0)]))
  binding.restack = { b in for i in b.cards.indices { b.cards[i].y += 24 } }
  var r = store.state.records["a"]!.current
  r["color"] = .number(3)
  store.merge([Incoming(id: "a", version: 2, record: r)])
  binding.pull()
  #expect(model.board.card("a")?.y == 24)
  #expect(model.board.card("a")?.color == 3)
  binding.flush()
  #expect(store.board(id).card("a")?.y == 0)
  #expect(store.pending.isEmpty)
}

@MainActor @Test func localEditsReachTheStoreFieldByField() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  var r = store.state.records["a"]!.current
  r["text"] = .string("theirs")
  store.merge([Incoming(id: "a", version: 2, record: r)])
  model.perform("Colour") { $0.setColor(["a"], 3) }
  binding.flush()
  let c = store.board(id).card("a")!
  #expect(c.text == "theirs" && c.color == 3)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter BoardBinding`
Expected: build failure, `cannot find 'BoardBinding' in scope`.

- [ ] **Step 3: Write `BoardBinding.swift`**

```swift
import Foundation

/// Keeps an open board's model and the store in step. Local edits go into the store field by field,
/// so they never overwrite a field the other device changed. Changes merged from the server come
/// back once no gesture is under way, stacked as this device shows them; the restacked positions
/// stay local, as devices measure text differently and would push each other's layouts forever.
public final class BoardBinding {
  public let id: String
  public let model: BoardModel
  public let store: Store
  public var restack: ((inout Board) -> Void)?
  /// The board as last given to or taken from the store, stacked as shown.
  private var seen: Board
  private var waiting = false
  private var flushing = false

  public init(id: String, model: BoardModel, store: Store) {
    self.id = id
    self.model = model
    self.store = store
    seen = model.board
    model.onEdit = { [weak self] in self?.changed() }
    model.onGestureEnd = { [weak self] in
      // after the gesture's undo step is registered, so that the step holds only local changes
      DispatchQueue.main.async { if self?.waiting == true { self?.pull() } }
    }
  }

  /// After every change to the model: flushes shortly.
  public func changed() {
    guard !flushing else { return }
    flushing = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      self?.flushing = false
      self?.flush()
    }
  }

  public func flush() {
    guard model.board != seen else { return }
    let changes = Records.changes(from: seen, to: model.board, board: id, orders: store.orders(of: id))
    seen = model.board
    store.apply(changes)
  }

  /// After the store merged changes for this board.
  public func pull() {
    flush()
    guard !model.inGesture else {
      waiting = true
      return
    }
    waiting = false
    var b = store.board(id)
    restack?(&b)
    seen = b
    model.applyRemote(b)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add BreezyKit
git commit --message "Bind an open board to the store field by field" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 7: The sync engine in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Sync.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/SyncFakes.swift`, `SyncTests.swift`

**Interfaces:**
- Consumes: `Store`, `SpaceKeys`, `Record`, `Records`, `Base64URL`
- Produces: `struct Pulled { id; version; blob }`, `struct Page { records: [Pulled]; cursor: Int }`, `struct Write { id; base; blob }`, `struct Accepted { id; version }`, `struct PushResult { accepted: [Accepted]; refused: [Pulled] }` (all Codable)
- Produces: `enum TransportError { offline, unreachable, unauthorized, tooLarge }`, `protocol Transport { pull(since:) async throws -> Page; push(_:) async throws -> PushResult }`, `struct HTTPTransport: Transport { init?(server:space:token:session:) }`
- Produces: `struct SyncStatus { enum State { local, synced, offline, unreachable, notInSpace }; state; at; waiting; unreadable; held; tooLong; lines(now:) -> [String] }`
- Produces: `@MainActor final class SyncEngine { pageSize = 500; maxBlob = 65_536; store; status; onStatus; flushLocal; init(store:now:transport:); sync() async; changed(); reset() }`

- [ ] **Step 1: Write the fakes**

`BreezyKit/Tests/BreezyKitTests/SyncFakes.swift`:

```swift
import Foundation
@testable import BreezyKit

/// The server's rules, in memory.
final class FakeServer {
  var records: [String: Pulled] = [:]
  var version = 0

  func pull(since: Int) -> Page {
    let r = Array(records.values.filter { $0.version > since }.sorted { $0.version < $1.version }.prefix(SyncEngine.pageSize))
    return Page(records: r, cursor: r.last?.version ?? since)
  }

  func push(_ writes: [Write]) -> PushResult {
    var accepted: [Accepted] = [], refused: [Pulled] = []
    for w in writes {
      if let stored = records[w.id], stored.version != w.base {
        refused.append(stored)
        continue
      }
      version += 1
      records[w.id] = Pulled(id: w.id, version: version, blob: w.blob)
      accepted.append(Accepted(id: w.id, version: version))
    }
    return PushResult(accepted: accepted, refused: refused)
  }

  /// Adds a record as another device would.
  func put(_ id: String, blob: String) {
    version += 1
    records[id] = Pulled(id: id, version: version, blob: blob)
  }
}

final class FakeTransport: Transport {
  let server: FakeServer
  var online = true
  var failure: TransportError?
  var calls = 0

  init(_ server: FakeServer) { self.server = server }

  func pull(since: Int) async throws -> Page {
    try check()
    return server.pull(since: since)
  }

  func push(_ writes: [Write]) async throws -> PushResult {
    try check()
    return server.push(writes)
  }

  private func check() throws {
    calls += 1
    if let failure { throw failure }
    if !online { throw TransportError.offline }
  }
}

let testServer = "https://example.com/breezy/sync.php"

@MainActor final class Device {
  let store = Store()
  let transport: FakeTransport
  let engine: SyncEngine

  init(_ server: FakeServer, joining invite: Invite? = nil) {
    let t = FakeTransport(server)
    transport = t
    engine = SyncEngine(store: store, transport: { _, _ in t })
    if let invite { store.join(invite) }
  }

  /// Changes board `id` as the app does.
  func edit(_ id: String, _ change: (inout Board) -> Void) {
    let old = store.board(id)
    var new = old
    change(&new)
    store.apply(Records.changes(from: old, to: new, board: id, orders: store.orders(of: id)))
  }
}

/// Two devices in one space with a board holding one card, both synced.
@MainActor func pair() async -> (FakeServer, Device, Device, String) {
  let server = FakeServer()
  let a = Device(server)
  let invite = a.store.startSyncing(server: testServer)
  let id = a.store.createBoard(title: "Plans", contents: board([card(newID(), 0, 0, "x")]))
  await a.engine.sync()
  let b = Device(server, joining: invite)
  await b.engine.sync()
  return (server, a, b, id)
}

struct SplitMix: RandomNumberGenerator {
  var state: UInt64

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
```

- [ ] **Step 2: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/SyncTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

@MainActor @Test func aJoiningDeviceGetsTheBoards() async {
  let (_, a, b, id) = await pair()
  #expect(b.store.boards.map(\.title) == ["Plans"])
  #expect(b.store.board(id) == a.store.board(id))
  #expect(a.engine.status.state == .synced)
  #expect(a.store.pending.isEmpty && b.store.pending.isEmpty)
}

@MainActor @Test func editsToDifferentFieldsOfACardCombine() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 3) }
  b.edit(id) { $0.setText(c, "y") }
  await a.engine.sync()
  await b.engine.sync()
  await a.engine.sync()
  for d in [a, b] {
    #expect(d.store.board(id).cards.map(\.color) == [3])
    #expect(d.store.board(id).cards.map(\.text) == ["y"])
  }
}

@MainActor @Test func textEditedOnBothSidesEndsAsTwoCards() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setText(c, "from a") }
  b.edit(id) { $0.setText(c, "from b") }
  await a.engine.sync()
  await b.engine.sync()
  await a.engine.sync()
  for d in [a, b] { #expect(d.store.board(id).cards.map(\.text).sorted() == ["from a", "from b"]) }
}

@MainActor @Test func offlineChangesWaitAndAreCounted() async {
  let (_, a, _, id) = await pair()
  a.transport.online = false
  a.edit(id) { $0.addCard(x: 0, y: 0) }
  await a.engine.sync()
  #expect(a.engine.status.state == .offline)
  #expect(a.engine.status.lines() == ["Offline — 1 change waiting"])
  a.transport.online = true
  let calls = a.transport.calls
  await a.engine.sync()
  #expect(a.transport.calls == calls)
  a.engine.reset()
  await a.engine.sync()
  #expect(a.engine.status.state == .synced)
  #expect(a.engine.status.lines() == ["Synced just now"])
  #expect(a.store.pending.isEmpty)
}

@MainActor @Test func aRefusedTokenStopsSyncing() async {
  let (_, a, _, _) = await pair()
  a.transport.failure = .unauthorized
  await a.engine.sync()
  #expect(a.engine.status.lines() == ["Not in this space any more"])
  let calls = a.transport.calls
  await a.engine.sync()
  #expect(a.transport.calls == calls)
}

@MainActor @Test func anUnreachableServerIsSaidSo() async {
  let (_, a, _, _) = await pair()
  a.transport.failure = .unreachable
  await a.engine.sync()
  #expect(a.engine.status.lines() == ["Can’t reach server"])
}

@MainActor @Test func anUnreadableRecordIsSkippedAndCounted() async {
  let (server, a, _, _) = await pair()
  server.put(newID(), blob: "AAAA")
  await a.engine.sync()
  #expect(a.store.state.unreadable == 1)
  #expect(a.store.state.cursor == server.version)
  #expect(a.engine.status.lines().contains("1 unreadable change"))
}

@MainActor @Test func aRecordFromANewerBreezyWaits() async throws {
  let (server, a, _, _) = await pair()
  let keys = try SpaceKeys(state: a.store.state)
  let id = newID()
  let plain = try JSONEncoder().encode(Record(["format": .number(2), "kind": .string("board"), "title": .string("Later")]))
  server.put(id, blob: Base64URL.encode(try keys.seal(plain, id: Base64URL.decode(id)!)))
  await a.engine.sync()
  #expect(a.store.state.held[id] != nil)
  #expect(!a.store.boards.map(\.title).contains("Later"))
  #expect(a.engine.status.lines().contains("Update Breezy to see all changes"))
}

@MainActor @Test func aCardTooLongToSyncStaysHere() async {
  let (_, a, _, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setText(c, String(repeating: "x", count: 70_000)) }
  await a.engine.sync()
  #expect(a.engine.status.lines().contains("Card too long to sync"))
  #expect(a.store.pending.map(\.id) == [c])
}

@MainActor @Test func pullsComeInPages() async {
  let server = FakeServer()
  let a = Device(server)
  let invite = a.store.startSyncing(server: testServer)
  let cards = (0..<600).map { card(newID(), 0, Double($0) * 24) }
  let id = a.store.createBoard(title: "Big", contents: board(cards))
  await a.engine.sync()
  let b = Device(server, joining: invite)
  await b.engine.sync()
  #expect(b.store.board(id).cards.count == 600)
}

@MainActor @Test func localEditsAreFlushedBeforeAMerge() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  b.edit(id) { $0.setText(c, "theirs") }
  await b.engine.sync()
  var flushed = 0
  a.engine.flushLocal = { flushed += 1 }
  await a.engine.sync()
  #expect(flushed >= 2)
  #expect(a.store.board(id).card(c)?.text == "theirs")
}

@MainActor @Test func fourDevicesEndTheSame() async {
  let server = FakeServer()
  let first = Device(server)
  let invite = first.store.startSyncing(server: testServer)
  let id = first.store.createBoard(title: "Plans")
  await first.engine.sync()
  let devices = [first] + (0..<3).map { _ in Device(server, joining: invite) }
  var rng = SplitMix(state: 42)
  for _ in 0..<300 {
    let d = devices[Int.random(in: 0..<4, using: &rng)]
    switch Int.random(in: 0..<10, using: &rng) {
    case 0:
      d.transport.online.toggle()
    case 1...3:
      d.engine.reset()
      await d.engine.sync()
    default:
      let pick = Int.random(in: 0..<6, using: &rng)
      let n = Int.random(in: 0..<1000, using: &rng)
      d.edit(id) { b in
        let i = b.cards.isEmpty ? nil : n % b.cards.count
        switch (pick, i) {
        case (0, _): b.addCard(x: Double(n % 20) * 24, y: 0)
        case (1, let i?): b.setText(b.cards[i].id, "t\(n)")
        case (2, let i?): b.setColor([b.cards[i].id], n % 5 + 1)
        case (3, let i?): b.moveCards([Origin(id: b.cards[i].id, x: b.cards[i].x, y: b.cards[i].y)], dx: 24, dy: 24)
        case (4, let i?): b.remove([b.cards[i].id])
        case (5, let i?):
          let c = b.cards.remove(at: i)
          b.cards.append(c)
        default: break
        }
      }
    }
  }
  for d in devices {
    d.transport.online = true
    d.engine.reset()
  }
  for _ in 0..<3 { for d in devices { await d.engine.sync() } }
  let expected = devices[0].store.board(id)
  for d in devices {
    #expect(d.store.pending.isEmpty)
    #expect(d.store.board(id) == expected)
  }
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter Sync`
Expected: build failure, `cannot find 'SyncEngine' in scope`.

- [ ] **Step 4: Write `Sync.swift`**

```swift
import Foundation

public struct Pulled: Codable, Equatable, Sendable {
  public var id: String
  public var version: Int
  public var blob: String
}

public struct Page: Codable, Equatable, Sendable {
  public var records: [Pulled]
  public var cursor: Int
}

public struct Write: Codable, Equatable, Sendable {
  public var id: String
  public var base: Int
  public var blob: String
}

public struct Accepted: Codable, Equatable, Sendable {
  public var id: String
  public var version: Int
}

public struct PushResult: Codable, Equatable, Sendable {
  public var accepted: [Accepted]
  public var refused: [Pulled]
}

public enum TransportError: Error, Equatable {
  case offline, unreachable, unauthorized, tooLarge
}

/// The server's two calls; see server/sync.php.
public protocol Transport {
  func pull(since: Int) async throws -> Page
  func push(_ writes: [Write]) async throws -> PushResult
}

public struct HTTPTransport: Transport {
  let server: URL
  let space: String
  let token: String
  let session: URLSession

  public init?(server: String, space: String, token: Data, session: URLSession = .shared) {
    guard let url = URL(string: server) else { return nil }
    self.server = url
    self.space = space
    self.token = Base64URL.encode(token)
    self.session = session
  }

  public func pull(since: Int) async throws -> Page {
    let data = try await send([URLQueryItem(name: "since", value: String(since))], body: nil)
    return try JSONDecoder().decode(Page.self, from: data)
  }

  public func push(_ writes: [Write]) async throws -> PushResult {
    let data = try await send([], body: JSONEncoder().encode(["writes": writes]))
    return try JSONDecoder().decode(PushResult.self, from: data)
  }

  private func send(_ query: [URLQueryItem], body: Data?) async throws -> Data {
    var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: space)] + query
    var r = URLRequest(url: c.url!, timeoutInterval: 20)
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      r.httpMethod = "POST"
      r.httpBody = body
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let data: Data, response: URLResponse
    do {
      (data, response) = try await session.data(for: r)
    } catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed].contains(e.code) {
      throw TransportError.offline
    } catch {
      throw TransportError.unreachable
    }
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: return data
    case 401: throw TransportError.unauthorized
    case 413: throw TransportError.tooLarge
    default: throw TransportError.unreachable
    }
  }
}

public struct SyncStatus: Equatable, Sendable {
  public enum State: Equatable, Sendable { case local, synced, offline, unreachable, notInSpace }
  public var state: State = .local
  public var at: Date?
  public var waiting = 0
  public var unreadable = 0
  public var held = 0
  public var tooLong = 0

  /// As the menus show it, a line each.
  public func lines(now: Date = Date()) -> [String] {
    func count(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
    var out: [String]
    switch state {
    case .local: out = ["Not syncing"]
    case .synced:
      let minutes = Int(now.timeIntervalSince(at ?? now) / 60)
      out = [minutes < 1 ? "Synced just now" : "Synced \(minutes) min ago"]
    case .offline: out = [waiting == 0 ? "Offline" : "Offline — \(count(waiting, "change", "changes")) waiting"]
    case .unreachable: out = ["Can’t reach server"]
    case .notInSpace: out = ["Not in this space any more"]
    }
    if unreadable > 0 { out.append(count(unreadable, "unreadable change", "unreadable changes")) }
    if held > 0 { out.append("Update Breezy to see all changes") }
    if tooLong > 0 { out.append("Card too long to sync") }
    return out
  }
}

/// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at
/// a time; see the sync design.
@MainActor public final class SyncEngine {
  public static let pageSize = 500
  public static let maxBlob = 65_536
  static let maxRequest = 900_000
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  public let store: Store
  public private(set) var status = SyncStatus()
  public var onStatus: ((SyncStatus) -> Void)?
  /// Called before merging, so that edits not yet in the store get there first.
  public var flushLocal: (() -> Void)?
  private let makeTransport: (SpaceState, SpaceKeys) -> Transport?
  private let now: () -> Date
  private var running = false, again = false, stopped = false, heldTried = false
  private var failures = 0, tooLong = 0
  private var retryAt: Date?
  private var soon: Task<Void, Never>?

  public init(
    store: Store, now: @escaping () -> Date = Date.init,
    transport: @escaping (SpaceState, SpaceKeys) -> Transport? = { s, k in HTTPTransport(server: s.server ?? "", space: s.space ?? "", token: k.token) }
  ) {
    self.store = store
    self.now = now
    makeTransport = transport
  }

  /// One cycle; a call during a cycle runs another after it.
  public func sync() async {
    if running {
      again = true
      return
    }
    running = true
    defer { running = false }
    repeat {
      again = false
      await cycle()
    } while again
  }

  /// A cycle a second from now, once however many changes come meanwhile.
  public func changed() {
    soon?.cancel()
    soon = Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled else { return }
      await self?.sync()
    }
  }

  /// Forgets a back-off and a refused token, as after joining a space.
  public func reset() {
    failures = 0
    retryAt = nil
    stopped = false
    heldTried = false
  }

  private func cycle() async {
    let state = store.state
    guard let keys = try? SpaceKeys(state: state), let transport = makeTransport(state, keys) else { return update(.local) }
    guard !stopped, retryAt.map({ $0 <= now() }) ?? true else { return }
    let space = state.space
    func same() -> Bool { store.state.space == space }
    do {
      flushLocal?()
      if !heldTried {
        heldTried = true
        retryHeld(keys)
      }
      while true {
        let page = try await transport.pull(since: store.state.cursor)
        guard same() else { return }
        flushLocal?()
        store.merge(page.records.compactMap { decode($0, keys) })
        store.advance(to: page.cursor)
        if page.records.count < Self.pageSize { break }
      }
      var refusals = 0
      for _ in 0..<10 {
        flushLocal?()
        let (writes, sent) = outgoing(keys)
        if writes.isEmpty { break }
        let result = try await transport.push(writes)
        guard same() else { return }
        for a in result.accepted { if let r = sent[a.id] { store.accepted(a.id, version: a.version, record: r) } }
        if result.refused.isEmpty { continue }
        flushLocal?()
        store.merge(result.refused.compactMap { decode($0, keys) })
        refusals += 1
        if refusals == 3 { throw TransportError.unreachable }
      }
      failures = 0
      retryAt = nil
      update(.synced)
    } catch TransportError.unauthorized {
      stopped = true
      update(.notInSpace)
    } catch {
      failures += 1
      retryAt = now().addingTimeInterval(min(60, 5 * pow(2, Double(failures - 1))))
      update(error as? TransportError == .offline ? .offline : .unreachable)
    }
  }

  private func decode(_ p: Pulled, _ keys: SpaceKeys) -> Incoming? {
    guard let id = Base64URL.decode(p.id), let blob = Base64URL.decode(p.blob), let plain = try? keys.open(blob, id: id),
          let record = try? JSONDecoder().decode(Record.self, from: plain) else {
      store.noteUnreadable()
      return nil
    }
    guard record.format <= Record.format else {
      store.hold(p.id, version: p.version, blob: p.blob)
      return nil
    }
    return Incoming(id: p.id, version: p.version, record: record)
  }

  /// Records held for a newer Breezy, which this one may now read.
  private func retryHeld(_ keys: SpaceKeys) {
    var ready: [Incoming] = []
    for (id, h) in store.state.held {
      store.release(id)
      if let r = decode(Pulled(id: id, version: h.version, blob: h.blob), keys) { ready.append(r) }
    }
    store.merge(ready)
  }

  private func outgoing(_ keys: SpaceKeys) -> ([Write], [String: Record]) {
    var writes: [Write] = [], sent: [String: Record] = [:], size = 0
    tooLong = 0
    for p in store.pending {
      guard let id = Base64URL.decode(p.id), id.count == 16, let plain = try? Self.encoder.encode(p.record),
            let blob = try? keys.seal(plain, id: id) else { continue }
      guard blob.count <= Self.maxBlob else {
        tooLong += 1
        continue
      }
      let w = Write(id: p.id, base: p.base, blob: Base64URL.encode(blob))
      size += w.blob.count + 64
      if size > Self.maxRequest { break }
      writes.append(w)
      sent[p.id] = p.record
    }
    return (writes, sent)
  }

  private func update(_ state: SyncStatus.State) {
    status = SyncStatus(
      state: state, at: state == .synced ? now() : status.at, waiting: store.pending.count,
      unreadable: store.state.unreadable, held: store.state.held.count, tooLong: tooLong)
    onStatus?(status)
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path BreezyKit`
Expected: all pass. If `fourDevicesEndTheSame` fails, print `d.store.board(id)` for the device that differs and the server's version count; a difference means a merge rule or the push loop is wrong, never the test.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit
git commit --message "Pull, merge and push a space's records" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 8: Records and order keys in JavaScript

**Files:**
- Create: `web/sync/base64.js`, `web/sync/order-key.js`, `web/sync/records.js`
- Modify: `web/rules.js:30-46` (`newID`, `addCard`, `addLane`)
- Test: `web/test/order-key.test.js`, `web/test/records.test.js`, `web/test/helpers/fixture.js`

**Interfaces:**
- Produces: `encode(bytes: Uint8Array) -> string`, `decode(text) -> Uint8Array | null` (base64.js)
- Produces: `newID()` in rules.js, 16 random bytes as base64url
- Produces: `between(a, b)`, `valid(key)`, `assign(ids, keys)` (order-key.js)
- Produces: `FORMAT`, `cardRecord(c, board, order)`, `laneRecord(l, board)`, `boardRecord(title)`, `deletedRecord(kind)`, `boardFrom(records, id)`, `changes(old, now, board, orders)` returning `{ [id]: { fields } | { deleted: kind } }` (records.js)
- Produces (tests): `fixture(name)` returning parsed JSON

- [ ] **Step 1: Write the failing tests**

`web/test/helpers/fixture.js`:

```js
import { readFileSync } from "node:fs";

/** A file from BreezyKit/Tests/Fixtures, which the Swift tests read too. */
export const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../BreezyKit/Tests/Fixtures/${name}`, import.meta.url), "utf8"));
```

`web/test/order-key.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { between, valid, assign } from "../sync/order-key.js";
import { fixture } from "./helpers/fixture.js";

const cases = fixture("order-key.json");

test("order keys match the shared cases", () => {
  for (const [a, b, want] of cases.between) assert.equal(between(a, b), want, `${a} ${b}`);
  for (const c of cases.assign) assert.deepEqual(assign(c.ids, c.keys), c.result, c.name);
});

test("keys made one after another keep increasing", () => {
  const keys = [];
  let last = "";
  for (let i = 0; i < 200; i++) keys.push((last = between(last, null)));
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, 200);
  assert.ok(keys.every(valid));
});

test("a key between two sorts between them", () => {
  let hi = "W";
  for (let i = 0; i < 50; i++) {
    const m = between("V", hi);
    assert.ok("V" < m && m < hi);
    hi = m;
  }
});
```

`web/test/records.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFrom, cardRecord, changes, deletedRecord } from "../sync/records.js";
import { decode } from "../sync/base64.js";
import { newID } from "../rules.js";

const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y) => ({ id, x, y, w: 480, h: 720, title: "Lane" });
const records = (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.fields).map(([id, v]) => [id, v.fields]));

test("a board goes to records and back", () => {
  const b = { cards: [card("c1", 24, 48, "One"), card("c2", 0, 0, "Two")], lanes: [lane("l1", 0, 0)] };
  assert.deepEqual(boardFrom(records(changes({ cards: [], lanes: [] }, b, "B", {})), "B"), b);
});

test("only changed fields are written", () => {
  const old = { cards: [card("c1", 0, 0, "One")], lanes: [] };
  const now = { cards: [{ ...card("c1", 0, 0, "One"), color: 3 }], lanes: [] };
  assert.deepEqual(changes(old, now, "B", { c1: "V" }), { c1: { fields: { color: 3 } } });
});

test("reordering writes one order key", () => {
  const old = { cards: [card("a", 0, 0), card("b", 0, 0)], lanes: [] };
  const now = { cards: [card("b", 0, 0), card("a", 0, 0)], lanes: [] };
  assert.deepEqual(changes(old, now, "B", { a: "V", b: "l" }), { b: { fields: { order: "G" } } });
});

test("removed items are marked deleted", () => {
  const old = { cards: [card("a", 0, 0)], lanes: [lane("l", 0, 0)] };
  assert.deepEqual(changes(old, { cards: [], lanes: [] }, "B", { a: "V" }), { a: { deleted: "card" }, l: { deleted: "lane" } });
});

test("bad values from another device fall back", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", color: 9, pos: "x" } }, "B").cards;
  assert.deepEqual(c, { id: "c", x: 0, y: 0, w: 240, text: "", color: 5 });
});

test("deleted records and other boards are left out", () => {
  const recs = { a: cardRecord(card("a", 0, 0), "B", "V"), b: cardRecord(card("b", 0, 0), "C", "V"), d: deletedRecord("card") };
  assert.deepEqual(boardFrom(recs, "B").cards.map((c) => c.id), ["a"]);
});

test("new ids are 16 random bytes", () => {
  const id = newID();
  assert.equal(id.length, 22);
  assert.equal(decode(id).length, 16);
  assert.notEqual(newID(), id);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/order-key.test.js web/test/records.test.js`
Expected: FAIL, `Cannot find module '…/web/sync/order-key.js'`.

- [ ] **Step 3: Write the implementation**

`web/sync/base64.js`:

```js
// Base64 with - and _ and no padding, as ids, keys and blobs travel.

export function encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decode(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
```

`web/sync/order-key.js`:

```js
// Fractional order keys, as BreezyKit's OrderKey: base-62 digits compared as strings, never ending in "0", so that a
// key fits between any two. Cards sort by key, then id, so equal keys are harmless.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const valid = (k) => typeof k === "string" && k.length > 0 && !k.endsWith("0") && [...k].every((c) => DIGITS.includes(c));

/** A key after `a` and before `b`; "" is the start and null the end. Needs a < b, both valid or "". */
export function between(a, b) {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + between(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.floor((da + db + 1) / 2)];
  if (b !== null && b.length > 1) return b[0];
  return DIGITS[da] + between(a.slice(1), null);
}

/** The indices of a longest strictly increasing run of the keys present. */
function longestIncreasing(keys) {
  const tails = [];
  const prev = new Array(keys.length).fill(null);
  keys.forEach((k, i) => {
    if (k === null) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (keys[tails[m]] < k) lo = m + 1;
      else hi = m;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : null;
    tails[lo] = i;
  });
  const out = new Set();
  for (let at = tails.at(-1) ?? null; at !== null; at = prev[at]) out.add(at);
  return out;
}

/** Keys for `ids` in this order, keeping as many of `keys` as stay in order, so a reorder rewrites few cards. */
export function assign(ids, keys) {
  const known = ids.map((id) => (valid(keys[id]) ? keys[id] : null));
  const kept = longestIncreasing(known);
  const out = {};
  let i = 0;
  while (i < ids.length) {
    if (kept.has(i)) {
      out[ids[i]] = known[i];
      i++;
      continue;
    }
    let j = i;
    while (j < ids.length && !kept.has(j)) j++;
    let lo = i > 0 ? out[ids[i - 1]] : "";
    const hi = j < ids.length ? known[j] : null;
    for (let k = i; k < j; k++) out[ids[k]] = lo = between(lo, hi);
    i = j;
  }
  return out;
}
```

`web/sync/records.js`:

```js
// Boards as records and back, as BreezyKit's Records. A card's pos and a lane's pos and size are pairs, so that a
// merge never takes x from one move and y from another.
import { CARD_W, LANE_W, LANE_H } from "../rules.js";
import { assign } from "./order-key.js";

export const FORMAT = 1;

export const cardRecord = (c, board, order) => ({
  format: FORMAT, kind: "card", board, text: c.text, notes: c.notes ?? "", color: c.color, pos: [c.x, c.y], w: c.w, order,
});
export const laneRecord = (l, board) => ({ format: FORMAT, kind: "lane", board, title: l.title, pos: [l.x, l.y], size: [l.w, l.h] });
export const boardRecord = (title) => ({ format: FORMAT, kind: "board", title });
export const deletedRecord = (kind) => ({ format: FORMAT, kind, deleted: true });

const pair = (v, fallback) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : fallback);
const text = (v) => (typeof v === "string" ? v : "");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Board `id` as `records` describe it: cards by order key, then id; lanes by id. */
export function boardFrom(records, id) {
  const cards = [], lanes = [];
  for (const [rid, r] of Object.entries(records)) {
    if (r.deleted || r.board !== id) continue;
    const [x, y] = pair(r.pos, [0, 0]);
    if (r.kind === "card") {
      const notes = text(r.notes);
      const color = Math.min(5, Math.max(1, Math.trunc(Number(r.color)) || 1));
      const w = Number.isFinite(r.w) ? r.w : CARD_W;
      cards.push({ order: text(r.order), card: { id: rid, x, y, w, text: text(r.text), color, ...(notes ? { notes } : {}) } });
    } else if (r.kind === "lane") {
      const [w, h] = pair(r.size, [LANE_W, LANE_H]);
      lanes.push({ id: rid, x, y, w, h, title: text(r.title) });
    }
  }
  cards.sort((a, b) => cmp(a.order, b.order) || cmp(a.card.id, b.card.id));
  lanes.sort((a, b) => cmp(a.id, b.id));
  return { cards: cards.map((c) => c.card), lanes };
}

const diff = (a, b) => Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)));

/** What changed from `old` to `now`, both board `id`: whole records for new items, changed fields, deletions. */
export function changes(old, now, board, orders) {
  const out = {};
  const keys = assign(now.cards.map((c) => c.id), orders);
  const put = (id, before, after) => {
    const d = before ? diff(before, after) : after;
    if (Object.keys(d).length) out[id] = { fields: d };
  };
  const oldCards = new Map(old.cards.map((c) => [c.id, c]));
  for (const c of now.cards) {
    const was = oldCards.get(c.id);
    put(c.id, was && cardRecord(was, board, orders[c.id] ?? ""), cardRecord(c, board, keys[c.id]));
  }
  const oldLanes = new Map(old.lanes.map((l) => [l.id, l]));
  for (const l of now.lanes) {
    const was = oldLanes.get(l.id);
    put(l.id, was && laneRecord(was, board), laneRecord(l, board));
  }
  const cardIDs = new Set(now.cards.map((c) => c.id)), laneIDs = new Set(now.lanes.map((l) => l.id));
  for (const c of old.cards) if (!cardIDs.has(c.id)) out[c.id] = { deleted: "card" };
  for (const l of old.lanes) if (!laneIDs.has(l.id)) out[l.id] = { deleted: "lane" };
  return out;
}
```

In `web/rules.js`, add `import { encode } from "./sync/base64.js";` at the top and replace `newID` and its two callers:

```js
/** 16 random bytes: ids are made on every device and must not collide. */
export function newID() {
  return encode(crypto.getRandomValues(new Uint8Array(16)));
}
```

`addCard` and `addLane` then call `newID()`.

- [ ] **Step 4: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass. A test that matched an id prefix such as `"c"` should now check `length === 22`.

- [ ] **Step 5: Commit**

```bash
git add web
git commit --message "Describe web boards as records with order keys" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 9: Three-way merge in JavaScript

**Files:**
- Create: `web/sync/merge.js`
- Test: `web/test/merge.test.js`

**Interfaces:**
- Produces: `mergeRecord(base | null, local, incoming) -> { record, copy | null }`, `equalRecords(a, b) -> boolean` (key order ignored)

- [ ] **Step 1: Write the failing test**

`web/test/merge.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecord, equalRecords } from "../sync/merge.js";
import { fixture } from "./helpers/fixture.js";

test("merges match the shared cases", () => {
  for (const c of fixture("merge.json")) {
    const r = mergeRecord(c.base, c.local, c.incoming);
    assert.deepEqual(r.record, c.record, c.name);
    assert.deepEqual(r.copy, c.copy, c.name);
  }
});

test("records are equal whatever the order of their fields", () => {
  assert.ok(equalRecords({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!equalRecords({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!equalRecords({ a: 1 }, null));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/test/merge.test.js`
Expected: FAIL, cannot find `../sync/merge.js`.

- [ ] **Step 3: Write `web/sync/merge.js`**

```js
// Three-way merge of one record, as BreezyKit's Merge: each field takes the side that changed it, the server's when
// both did; text or notes both sides changed differently, or changed on one side and deleted on the other, go into a
// copy card so that nothing typed is lost.

const TEXTS = ["text", "notes"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function equalRecords(a, b) {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
}

function copyOf(r) {
  const c = structuredClone(r);
  if (Array.isArray(r.pos) && r.pos.length === 2) c.pos = [r.pos[0] + 24, r.pos[1] + 24];
  return c;
}

export function mergeRecord(base, local, incoming) {
  base ??= {};
  if (incoming.deleted || local.deleted) {
    const survivor = incoming.deleted ? (local.deleted ? null : local) : incoming;
    const marker = incoming.deleted ? incoming : local;
    const changed = survivor && TEXTS.some((k) => !same(survivor[k], base[k]));
    return { record: marker, copy: changed ? copyOf(survivor) : null };
  }
  const record = {};
  let conflict = false;
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)])) {
    const b = base[k], l = local[k], i = incoming[k];
    let v;
    if (same(l, b)) v = i;
    else if (same(i, b) || same(i, l)) v = l;
    else {
      v = i;
      if (TEXTS.includes(k)) conflict = true;
    }
    if (v !== undefined) record[k] = v;
  }
  return { record, copy: conflict ? copyOf(local) : null };
}
```

- [ ] **Step 4: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web
git commit --message "Merge web records three ways" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 10: Undo that leaves the other device's changes alone, in JavaScript

**Files:**
- Create: `web/rebase.js`
- Modify: `web/model.js`
- Test: `web/test/rebase.test.js`, `web/test/model.test.js` (append)

**Interfaces:**
- Produces: `rebase(base, mine, theirs) -> board` (a fresh clone)
- Produces: `Model.applyRemote(board)`, `Model.replace(board)`; undo steps are `{ from, to, name }`

- [ ] **Step 1: Write the failing tests**

`web/test/rebase.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebase } from "../rebase.js";

const card = (id, extra = {}) => ({ id, x: 0, y: 0, w: 240, text: "t", color: 1, ...extra });
const board = (cards, lanes = []) => ({ cards, lanes });

test("rebase takes my changes onto theirs", () => {
  const r = rebase(board([card("a")]), board([card("a", { color: 3 })]), board([card("a", { text: "y" })]));
  assert.deepEqual(r.cards, [card("a", { color: 3, text: "y" })]);
});

test("rebase lets theirs win a field both changed", () => {
  assert.equal(rebase(board([card("a")]), board([card("a", { color: 3 })]), board([card("a", { color: 4 })])).cards[0].color, 4);
});

test("rebase removes what I removed unless they changed it", () => {
  const base = board([card("a"), card("b")], [{ id: "l", x: 0, y: 0, w: 480, h: 720, title: "L" }]);
  const theirs = board([card("a"), card("b", { text: "kept" })], base.lanes);
  const r = rebase(base, board([]), theirs);
  assert.deepEqual(r.cards.map((c) => c.id), ["b"]);
  assert.deepEqual(r.lanes, []);
});

test("rebase keeps what they added and the order I chose", () => {
  const r = rebase(board([card("a"), card("b")]), board([card("b"), card("a")]), board([card("a"), card("b"), card("c")]));
  assert.deepEqual(r.cards.map((c) => c.id), ["b", "a", "c"]);
});

test("rebase brings back notes I took off", () => {
  const r = rebase(board([card("a", { notes: "n" })]), board([card("a")]), board([card("a", { notes: "n" })]));
  assert.equal("notes" in r.cards[0], false);
});
```

Append to `web/test/model.test.js`:

```js
test("undo leaves changes from another device alone", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], x: 48 }] });
  m.undo();
  assert.equal(m.board.cards[0].color, 1);
  assert.equal(x(m), 48);
});

test("undo keeps a field the other device changed since", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 4 }] });
  m.undo();
  assert.equal(m.board.cards[0].color, 4);
});

test("redo puts back only what the step changed", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.undo();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], text: "y" }] });
  m.redo();
  assert.equal(m.board.cards[0].color, 3);
  assert.equal(m.board.cards[0].text, "y");
});

test("changes from another device add no step and wait for a gesture", () => {
  const m = fresh();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 2 }] });
  assert.equal(m.canUndo, false);
  m.begin();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 5 }] });
  assert.equal(m.board.cards[0].color, 2);
});

test("replace shows another board with no history", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.replace({ cards: [], lanes: [] });
  assert.deepEqual(m.board, { cards: [], lanes: [] });
  assert.equal(m.canUndo, false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/rebase.test.js web/test/model.test.js`
Expected: FAIL, cannot find `../rebase.js`, then `m.applyRemote is not a function`.

- [ ] **Step 3: Write `web/rebase.js`**

```js
// `mine`'s changes since `base`, made to `theirs` field by field, as BreezyKit's Board.rebase; where `theirs` changed a
// field too, `theirs` wins. Undo uses it so that a step back leaves changes from another device alone.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (b, m, t) => (same(t, b) ? m : t);

function item(b, m, t, merge) {
  if (b && m && t) return merge(b, m, t);
  if (b && !m && t) return same(t, b) ? null : t;
  if (b && !t) return null;
  if (!b && m && !t) return m;
  return t ?? null;
}

function card(b, m, t) {
  const c = { ...t };
  if (t.x === b.x && t.y === b.y) Object.assign(c, { x: m.x, y: m.y });
  for (const k of ["w", "text", "color"]) c[k] = pick(b[k], m[k], t[k]);
  const notes = pick(b.notes, m.notes, t.notes);
  if (notes === undefined) delete c.notes;
  else c.notes = notes;
  return c;
}

function lane(b, m, t) {
  const l = { ...t };
  if (t.x === b.x && t.y === b.y) Object.assign(l, { x: m.x, y: m.y });
  if (t.w === b.w && t.h === b.h) Object.assign(l, { w: m.w, h: m.h });
  l.title = pick(b.title, m.title, t.title);
  return l;
}

/** `keep` in `primary`'s order; the rest follow what came before them in `other`. */
function arrange(keep, primary, other) {
  const out = primary.filter((id) => keep.has(id));
  const placed = new Set(out);
  let last = -1;
  for (const id of other) {
    if (!keep.has(id)) continue;
    if (placed.has(id)) {
      last = Math.max(last, out.indexOf(id));
      continue;
    }
    out.splice(++last, 0, id);
    placed.add(id);
  }
  return out;
}

function merged(base, mine, theirs, merge) {
  const [b, m, t] = [base, mine, theirs].map((xs) => new Map(xs.map((x) => [x.id, x])));
  const out = new Map();
  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const x = item(b.get(id), m.get(id), t.get(id), merge);
    if (x) out.set(id, x);
  }
  return out;
}

export function rebase(base, mine, theirs) {
  const cards = merged(base.cards, mine.cards, theirs.cards, card);
  const ids = (xs) => xs.map((x) => x.id);
  const common = new Set(ids(mine.cards).filter((id) => ids(base.cards).includes(id)));
  const reordered = !same(ids(mine.cards).filter((id) => common.has(id)), ids(base.cards).filter((id) => common.has(id)));
  const cardOrder = reordered
    ? arrange(new Set(cards.keys()), ids(mine.cards), ids(theirs.cards))
    : arrange(new Set(cards.keys()), ids(theirs.cards), ids(mine.cards));
  const lanes = merged(base.lanes, mine.lanes, theirs.lanes, lane);
  const laneOrder = arrange(new Set(lanes.keys()), ids(theirs.lanes), ids(mine.lanes));
  return structuredClone({ cards: cardOrder.map((id) => cards.get(id)), lanes: laneOrder.map((id) => lanes.get(id)) });
}
```

- [ ] **Step 4: Change `web/model.js`**

Add `import { rebase } from "./rebase.js";` at the top. Replace `swap` and `record`, and add `applyRemote` and `replace`:

```js
  swap(from, to) {
    if (this.inGesture || !from.length) return;
    const step = from.pop();
    to.push({ from: step.to, to: step.from, name: step.name });
    this.board = rebase(step.from, step.to, this.board);
    this.onChange();
  }

  /** Changes from another device, without a step; waits for no gesture, as the caller does. */
  applyRemote(board) {
    if (this.inGesture) return;
    this.board = board;
    this.onChange();
  }

  /** Another board in place of this one, with no history. */
  replace(board) {
    this.board = board;
    this.start = null;
    this.undos = [];
    this.redos = [];
    this.onChange();
  }

  record(before, name) {
    this.undos.push({ from: structuredClone(this.board), to: before, name });
    if (this.undos.length > UNDO_LIMIT) this.undos.shift();
    this.redos = [];
  }
```

Add to the class comment: "A step undoes field by field, so changes from another device made since stay."

- [ ] **Step 5: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web
git commit --message "Undo web boards field by field" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 11: Keys, blobs and invites in JavaScript

**Files:**
- Create: `web/sync/crypto.js`
- Test: `web/test/crypto.test.js`

**Interfaces:**
- Consumes: `encode`, `decode` (Task 8)
- Produces: `randomBytes(n)`, `SpaceKeys.create(space, secret) -> Promise<SpaceKeys>` with `token: Uint8Array`, `seal(plain, id, nonce?) -> Promise<Uint8Array>`, `open(blob, id) -> Promise<Uint8Array>`
- Produces: `INVITE_PREFIX`, `inviteLink({ server, space, secret })`, `parseInvite(text) -> invite | null`, `validServer(s)`

- [ ] **Step 1: Write the failing tests**

`web/test/crypto.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpaceKeys, randomBytes, inviteLink, parseInvite, validServer, INVITE_PREFIX } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { fixture } from "./helpers/fixture.js";

const v = fixture("crypto.json");
const enc = new TextEncoder();

test("encryption matches the shared vector", async () => {
  const keys = await SpaceKeys.create(decode(v.space), decode(v.secret));
  assert.equal(encode(keys.token), v.token);
  assert.equal(encode(new Uint8Array(await crypto.subtle.digest("SHA-256", keys.token))), v.tokenHash);
  assert.equal(encode(await keys.seal(enc.encode(v.plaintext), decode(v.id), decode(v.nonce))), v.blob);
  assert.equal(new TextDecoder().decode(await keys.open(decode(v.blob), decode(v.id))), v.plaintext);
});

test("a blob moved to another record does not open", async () => {
  const keys = await SpaceKeys.create(randomBytes(16), randomBytes(32));
  const blob = await keys.seal(enc.encode("x"), randomBytes(16));
  await assert.rejects(keys.open(blob, randomBytes(16)));
});

test("invites go to links and back", () => {
  const invite = { server: v.server, space: v.space, secret: v.secret };
  assert.deepEqual(parseInvite(v.invite), invite);
  assert.equal(inviteLink(invite), v.invite);
  assert.ok(v.invite.startsWith(INVITE_PREFIX));
});

test("a pasted invite may have text around it", () => {
  assert.deepEqual(parseInvite(`Join me: ${v.invite}).\n`), { server: v.server, space: v.space, secret: v.secret });
});

test("what is not an invite is refused", () => {
  for (const text of [
    "", "https://arlol.github.io/breezy/", "https://arlol.github.io/breezy/#join=abc",
    inviteLink({ server: "ftp://example.com", space: v.space, secret: v.secret }),
    inviteLink({ server: v.server, space: "AAAA", secret: v.secret }),
    inviteLink({ server: v.server, space: v.space, secret: "AAAA" }),
  ]) assert.equal(parseInvite(text), null, text);
});

test("servers must be https or this computer", () => {
  assert.ok(validServer("https://example.com/breezy/sync.php"));
  assert.ok(validServer("http://localhost:58566/sync.php"));
  assert.ok(validServer("http://127.0.0.1:58566/sync.php"));
  assert.ok(!validServer("http://example.com/sync.php"));
  assert.ok(!validServer("example.com"));
  assert.ok(!validServer(""));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/crypto.test.js`
Expected: FAIL, cannot find `../sync/crypto.js`.

- [ ] **Step 3: Write `web/sync/crypto.js`**

```js
// A space's key and token, sealed records and invites, as BreezyKit's SpaceKeys and Invite.
import { encode, decode } from "./base64.js";

const enc = new TextEncoder();
export const INVITE_PREFIX = "https://arlol.github.io/breezy/#join=";
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export class SpaceKeys {
  static async create(space, secret) {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
    const info = (s) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(s) });
    const key = await crypto.subtle.deriveKey(info("breezy key"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const token = new Uint8Array(await crypto.subtle.deriveBits(info("breezy token"), base, 256));
    return new SpaceKeys(space, key, token);
  }

  constructor(space, key, token) {
    this.space = space;
    this.key = key;
    this.token = token;
  }

  aad(id) {
    const a = new Uint8Array(this.space.length + id.length);
    a.set(this.space);
    a.set(id, this.space.length);
    return a;
  }

  /** Nonce, ciphertext and tag; the space and record ids are bound in, so the blob opens nowhere else. */
  async seal(plain, id, nonce = randomBytes(12)) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: this.aad(id) }, this.key, plain));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce);
    out.set(ct, nonce.length);
    return out;
  }

  async open(blob, id) {
    const iv = blob.slice(0, 12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: this.aad(id) }, this.key, blob.slice(12)));
  }
}

/** HTTPS, or plain HTTP to this computer for trying the server out. */
export function validServer(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

export const inviteLink = ({ server, space, secret }) => INVITE_PREFIX + encode(enc.encode(JSON.stringify({ secret, server, space })));

/** The invite in pasted text, which may hold more than the link. */
export function parseInvite(text) {
  const at = text.indexOf("#join=");
  if (at < 0) return null;
  const bytes = decode(text.slice(at + 6).match(/^[A-Za-z0-9_-]*/)[0]);
  if (!bytes) return null;
  try {
    const { server, space, secret } = JSON.parse(new TextDecoder().decode(bytes));
    if (!validServer(server) || decode(space)?.length !== 16 || decode(secret)?.length !== 32) return null;
    return { server, space, secret };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web
git commit --message "Derive a space's key and token and encode invites on the web" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 12: The store, saving and the board binding in JavaScript

**Files:**
- Create: `web/sync/store.js`, `web/sync/saver.js`, `web/sync/idb.js`, `web/binding.js`
- Test: `web/test/store.test.js`, `web/test/saver.test.js`, `web/test/binding.test.js`

**Interfaces:**
- Consumes: records.js, merge.js, crypto.js, base64.js, rules.js `newID`, model.js `applyRemote`
- Produces: `emptyState()`, `withFreshIDs(board)`, `class Store { state; onChange(boards: Set, remote: bool); onDirty(); syncing; invite; boards(); title(id); board(id); createBoard(title, contents?); renameBoard(id, title); deleteBoard(id); apply(changes); orders(boardID); pending() -> [{ id, base, record }]; accepted(id, version, record); merge(items); advance(cursor); hold(id, version, blob); release(id); noteUnreadable(); join(invite); startSyncing(server) -> invite }`
- Produces: `class Saver { constructor(save, delay = 300); enabled; schedule(); flush() -> Promise }`
- Produces: `loadState() -> Promise<state | null>`, `saveState(state) -> Promise` (idb.js)
- Produces: `class Binding { constructor(store, model, id, restack); seen; changed(); flush(); pull() }`

- [ ] **Step 1: Write the failing tests**

`web/test/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, withFreshIDs } from "../sync/store.js";
import { deletedRecord } from "../sync/records.js";

const card = (id, text = "t") => ({ id, x: 0, y: 0, w: 240, text, color: 1 });
export const settle = (s, version = 1) => { for (const p of s.pending()) s.accepted(p.id, version, p.record); };

test("a new board waits to be pushed", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  assert.deepEqual(s.boards(), [{ id, title: "Plans" }]);
  assert.deepEqual(s.board(id), { cards: [card("c")], lanes: [] });
  assert.deepEqual(s.pending().map((p) => p.id).sort(), [id, "c"].sort());
});

test("accepted records stop waiting unless changed since", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  const sent = s.pending();
  s.apply({ c: { fields: { color: 2 } } });
  for (const p of sent) s.accepted(p.id, 1, p.record);
  assert.deepEqual(s.pending().map((p) => p.id), ["c"]);
});

test("edits and merges combine field by field", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c", "x")], lanes: [] });
  settle(s);
  s.apply({ c: { fields: { color: 3 } } });
  const heard = [];
  s.onChange = (boards, remote) => heard.push([[...boards], remote]);
  s.merge([{ id: "c", version: 2, record: { ...s.state.records.c.base, text: "theirs" } }]);
  assert.equal(s.board(id).cards[0].color, 3);
  assert.equal(s.board(id).cards[0].text, "theirs");
  assert.deepEqual(heard, [[[id], true]]);
});

test("an older version is ignored", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c", "now")], lanes: [] });
  settle(s, 5);
  s.merge([{ id: "c", version: 4, record: { ...s.state.records.c.current, text: "old" } }]);
  assert.equal(s.state.records.c.current.text, "now");
});

test("a text conflict adds a copy card", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c", "x")], lanes: [] });
  settle(s);
  s.apply({ c: { fields: { text: "mine" } } });
  s.merge([{ id: "c", version: 2, record: { ...s.state.records.c.base, text: "theirs" } }]);
  assert.deepEqual(s.board(id).cards.map((c) => c.text).sort(), ["mine", "theirs"]);
});

test("edits to a deleted record are dropped", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  settle(s);
  s.merge([{ id: "c", version: 2, record: deletedRecord("card") }]);
  s.apply({ c: { fields: { color: 3 } } });
  assert.deepEqual(s.board(id).cards, []);
});

test("deleting a board deletes what is on it", () => {
  const s = new Store();
  const id = s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  s.deleteBoard(id);
  assert.deepEqual(s.boards(), []);
  assert.equal(s.title(id), null);
  assert.ok(s.state.records.c.current.deleted);
});

test("joining replaces the boards here", () => {
  const s = new Store();
  s.createBoard("Mine");
  s.join({ server: "https://example.com/sync.php", space: "QEFCQ0RFRkdISUpLTE1OTw", secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" });
  assert.deepEqual(s.boards(), []);
  assert.ok(s.syncing);
});

test("starting to sync pushes everything", () => {
  const s = new Store();
  s.createBoard("Plans", { cards: [card("c")], lanes: [] });
  settle(s);
  const invite = s.startSyncing("https://example.com/sync.php");
  assert.deepEqual(s.invite, invite);
  assert.ok(s.pending().length === 2 && s.pending().every((p) => p.base === 0));
});

test("fresh ids keep the board otherwise", () => {
  const b = withFreshIDs({ cards: [card("c")], lanes: [{ id: "l", x: 0, y: 0, w: 480, h: 720, title: "L" }] });
  assert.equal(b.cards[0].id.length, 22);
  assert.deepEqual({ ...b.cards[0], id: "c" }, card("c"));
});
```

`web/test/saver.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Saver } from "../sync/saver.js";

test("schedule waits for the delay, once", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 20);
  s.schedule();
  s.schedule();
  assert.equal(saves, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saves, 1);
});

test("flush writes at once what is waiting", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 10_000);
  s.schedule();
  await s.flush();
  assert.equal(saves, 1);
  await s.flush();
  assert.equal(saves, 1);
});

test("a disabled saver writes nothing", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 10);
  s.enabled = false;
  s.schedule();
  await s.flush();
  assert.equal(saves, 0);
});
```

`web/test/binding.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../sync/store.js";
import { Model } from "../model.js";
import { Binding } from "../binding.js";
import { cardRecord } from "../sync/records.js";
import { settle } from "./store.test.js";

const card = (id, y, text = "x") => ({ id, x: 0, y, w: 240, text, color: 1 });

function opened(cards) {
  const store = new Store();
  const id = store.createBoard("B", { cards, lanes: [] });
  settle(store);
  const model = new Model(store.board(id));
  const binding = new Binding(store, model, id, () => {});
  model.onChange = () => binding.changed();
  return { store, id, model, binding };
}

test("a merge during a gesture waits and keeps the typed text", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  model.begin();
  model.update((b) => (b.cards[0].text = "typed"));
  store.merge([{ id: "n", version: 2, record: cardRecord(card("n", 96, "new"), id, "z") }]);
  binding.pull();
  assert.equal(model.board.cards.length, 1);
  model.end("Edit Card");
  assert.deepEqual(model.board.cards.map((c) => c.text), ["typed", "new"]);
  assert.equal(store.board(id).cards[0].text, "typed");
  model.undo();
  assert.deepEqual(model.board.cards.map((c) => c.text), ["x", "new"]);
});

test("restacking a merge is shown but not written", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  binding.restack = (b) => b.cards.forEach((c) => (c.y += 24));
  store.merge([{ id: "a", version: 2, record: { ...store.state.records.a.current, color: 3 } }]);
  binding.pull();
  assert.equal(model.board.cards[0].y, 24);
  assert.equal(model.board.cards[0].color, 3);
  binding.flush();
  assert.equal(store.board(id).cards[0].y, 0);
  assert.deepEqual(store.pending(), []);
});

test("local edits reach the store field by field", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  store.merge([{ id: "a", version: 2, record: { ...store.state.records.a.current, text: "theirs" } }]);
  model.perform("Colour", (b) => (b.cards[0].color = 3));
  binding.flush();
  assert.equal(store.board(id).cards[0].text, "theirs");
  assert.equal(store.board(id).cards[0].color, 3);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/store.test.js web/test/saver.test.js web/test/binding.test.js`
Expected: FAIL, cannot find `../sync/store.js`.

- [ ] **Step 3: Write the implementation**

`web/sync/store.js`:

```js
// The boards of one space as this device has them, as BreezyKit's Store. Records are never changed in place: a
// change makes a new object, so a record sent to the server can serve as the base afterwards.
import { newID } from "../rules.js";
import { boardFrom, boardRecord, changes, deletedRecord } from "./records.js";
import { mergeRecord, equalRecords } from "./merge.js";
import { encode } from "./base64.js";
import { randomBytes } from "./crypto.js";

export const emptyState = () => ({ server: null, space: null, secret: null, cursor: 0, records: {}, held: {}, unreadable: 0 });

export const withFreshIDs = (board) => ({
  cards: board.cards.map((c) => ({ ...c, id: newID() })),
  lanes: board.lanes.map((l) => ({ ...l, id: newID() })),
});

const empty = () => ({ cards: [], lanes: [] });

export class Store {
  constructor(state = emptyState()) {
    this.state = state;
    /** After a change to what boards show, with the boards concerned and whether it came from the server. */
    this.onChange = () => {};
    /** After any change, for saving. */
    this.onDirty = () => {};
  }

  get syncing() {
    const s = this.state;
    return !!(s.server && s.space && s.secret);
  }

  get invite() {
    const { server, space, secret } = this.state;
    return this.syncing ? { server, space, secret } : null;
  }

  current() {
    return Object.fromEntries(Object.entries(this.state.records).map(([id, s]) => [id, s.current]));
  }

  boards() {
    return Object.entries(this.state.records)
      .filter(([, s]) => s.current.kind === "board" && !s.current.deleted)
      .map(([id, s]) => ({ id, title: typeof s.current.title === "string" ? s.current.title : "" }))
      .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  title(id) {
    const r = this.state.records[id]?.current;
    if (!r || r.kind !== "board" || r.deleted) return null;
    return typeof r.title === "string" ? r.title : "";
  }

  board(id) {
    return boardFrom(this.current(), id);
  }

  createBoard(title, contents = empty()) {
    const id = newID();
    this.apply({ ...changes(empty(), contents, id, {}), [id]: { fields: boardRecord(title) } });
    return id;
  }

  renameBoard(id, title) {
    this.apply({ [id]: { fields: { title } } });
  }

  deleteBoard(id) {
    const out = { [id]: { deleted: "board" } };
    for (const [rid, s] of Object.entries(this.state.records)) {
      if (s.current.board === id && !s.current.deleted) out[rid] = { deleted: s.current.kind };
    }
    this.apply(out);
  }

  /** Local edits. A deleted record stays deleted; partial fields for an unknown record are dropped. */
  apply(edits) {
    const boards = new Set();
    for (const [id, change] of Object.entries(edits)) {
      const s = this.state.records[id];
      if (change.deleted) {
        if (!s || s.current.deleted) continue;
        boards.add(s.current.board ?? id);
        this.state.records[id] = { ...s, current: deletedRecord(change.deleted) };
      } else if (s) {
        if (s.current.deleted) continue;
        const current = { ...s.current, ...change.fields };
        this.state.records[id] = { ...s, current };
        boards.add(current.board ?? id);
      } else {
        if (!change.fields.kind) continue;
        this.state.records[id] = { base: null, version: 0, current: change.fields };
        boards.add(change.fields.board ?? id);
      }
    }
    if (!boards.size) return;
    this.onDirty();
    this.onChange(boards, false);
  }

  orders(board) {
    const out = {};
    for (const [id, s] of Object.entries(this.state.records)) {
      const r = s.current;
      if (r.kind === "card" && !r.deleted && r.board === board && typeof r.order === "string") out[id] = r.order;
    }
    return out;
  }

  pending() {
    return Object.entries(this.state.records)
      .filter(([, s]) => !equalRecords(s.current, s.base))
      .map(([id, s]) => ({ id, base: s.version, record: s.current }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The server took `record` as `version`; edits made since it was sent stay pending. */
  accepted(id, version, record) {
    const s = this.state.records[id];
    if (!s) return;
    this.state.records[id] = { ...s, base: record, version };
    this.onDirty();
  }

  /** Records from the server, merged three ways into those with local changes. */
  merge(items) {
    if (!items.length) return;
    const boards = new Set();
    for (const { id, version, record } of items) {
      const old = this.state.records[id];
      if (old && version <= old.version) continue;
      let current = record;
      if (old && !equalRecords(old.current, old.base)) {
        const m = mergeRecord(old.base, old.current, record);
        current = m.record;
        if (m.copy) this.state.records[newID()] = { base: null, version: 0, current: m.copy };
      }
      for (const b of [old?.current.board, current.board, record.board]) if (b) boards.add(b);
      if (record.kind === "board") boards.add(id);
      this.state.records[id] = { base: record, version, current };
    }
    this.onDirty();
    if (boards.size) this.onChange(boards, true);
  }

  advance(cursor) {
    this.state.cursor = Math.max(this.state.cursor, cursor);
    this.onDirty();
  }

  hold(id, version, blob) {
    this.state.held[id] = { version, blob };
    this.onDirty();
  }

  release(id) {
    delete this.state.held[id];
    this.onDirty();
  }

  noteUnreadable() {
    this.state.unreadable++;
    this.onDirty();
  }

  /** This device's boards give way to the space `invite` names. */
  join({ server, space, secret }) {
    const boards = new Set(this.boards().map((b) => b.id));
    this.state = { ...emptyState(), server, space, secret };
    this.onDirty();
    this.onChange(boards, true);
  }

  /** A new space on `server` for the boards here; every record waits to be pushed. */
  startSyncing(server) {
    const s = this.state;
    Object.assign(s, { server, space: encode(randomBytes(16)), secret: encode(randomBytes(32)), cursor: 0, held: {}, unreadable: 0 });
    for (const [id, r] of Object.entries(s.records)) s.records[id] = { ...r, base: null, version: 0 };
    this.onDirty();
    return this.invite;
  }
}
```

`web/sync/saver.js`:

```js
/** Writes what `save` saves shortly after the last `schedule`, or at once on `flush`; one write at a time. */
export class Saver {
  constructor(save, delay = 300) {
    this.save = save;
    this.delay = delay;
    this.enabled = true;
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  schedule() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.enabled) return this.writing;
    this.dirty = false;
    this.writing = this.writing.then(() => this.save()).catch((error) => console.warn("boards not saved", error));
    return this.writing;
  }
}
```

`web/sync/idb.js`:

```js
// The store's state in IndexedDB, under one key.

let opened = null;

function db() {
  opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("breezy", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return opened;
}

export async function loadState() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const q = d.transaction("state").objectStore("state").get("space");
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => reject(q.error);
  });
}

export async function saveState(state) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("state", "readwrite");
    t.objectStore("state").put(state, "space");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
```

`web/binding.js`:

```js
import { changes } from "./sync/records.js";

/**
 * Keeps the open board's model and the store in step, as BreezyKit's BoardBinding. Local edits go into the store field
 * by field, so they never overwrite a field the other device changed. Changes merged from the server come back once
 * no gesture is under way, stacked as this device shows them; the restacked positions stay local, as devices measure
 * text differently and would push each other's layouts forever.
 */
export class Binding {
  constructor(store, model, id, restack) {
    this.store = store;
    this.model = model;
    this.id = id;
    this.restack = restack;
    /** The board as last given to or taken from the store, stacked as shown. */
    this.seen = structuredClone(model.board);
    this.waiting = false;
    this.timer = null;
  }

  /** After every change to the model: a merge that waited comes in now, else the change is flushed shortly. */
  changed() {
    if (this.waiting && !this.model.inGesture) return this.pull();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    const c = changes(this.seen, this.model.board, this.id, this.store.orders(this.id));
    this.seen = structuredClone(this.model.board);
    if (Object.keys(c).length) this.store.apply(c);
  }

  /** After the store merged changes for this board. */
  pull() {
    this.flush();
    if (this.model.inGesture) {
      this.waiting = true;
      return;
    }
    this.waiting = false;
    const b = this.store.board(this.id);
    this.restack(b);
    this.seen = structuredClone(b);
    this.model.applyRemote(b);
  }
}
```

- [ ] **Step 4: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass, including `store.test.js` imported by `binding.test.js`.

- [ ] **Step 5: Commit**

```bash
git add web
git commit --message "Keep web boards in a store bound to the open board" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 13: The sync engine in JavaScript

**Files:**
- Create: `web/sync/engine.js`, `web/test/helpers/fake-server.js`
- Test: `web/test/engine.test.js`

**Interfaces:**
- Consumes: Store (Task 12), SpaceKeys (Task 11), `FORMAT`, `changes`
- Produces: `PAGE_SIZE`, `MAX_BLOB`, `class TransportError { kind }`, `class HttpTransport { constructor(server, space, token); pull(since); push(writes) }`, `statusLines(status, now?) -> string[]`
- Produces: `class SyncEngine { constructor(store, { transport?, now? }); status; onStatus(status); flushLocal(); sync() -> Promise; changed(); reset() }`; `transport(state, keys)` returns the transport

- [ ] **Step 1: Write the fakes**

`web/test/helpers/fake-server.js`:

```js
import { Store } from "../../sync/store.js";
import { SyncEngine, PAGE_SIZE, TransportError } from "../../sync/engine.js";
import { changes } from "../../sync/records.js";

/** The server's rules, in memory. */
export class FakeServer {
  constructor() {
    this.records = new Map();
    this.version = 0;
  }

  pull(since) {
    const records = [...this.records.values()].filter((r) => r.version > since).sort((a, b) => a.version - b.version).slice(0, PAGE_SIZE);
    return { records, cursor: records.at(-1)?.version ?? since };
  }

  push(writes) {
    const accepted = [], refused = [];
    for (const w of writes) {
      const stored = this.records.get(w.id);
      if (stored && stored.version !== w.base) {
        refused.push(stored);
        continue;
      }
      this.records.set(w.id, { id: w.id, version: ++this.version, blob: w.blob });
      accepted.push({ id: w.id, version: this.version });
    }
    return { accepted, refused };
  }

  put(id, blob) {
    this.records.set(id, { id, version: ++this.version, blob });
  }
}

export class FakeTransport {
  constructor(server) {
    this.server = server;
    this.online = true;
    this.failure = null;
    this.calls = 0;
  }

  check() {
    this.calls++;
    if (this.failure) throw new TransportError(this.failure);
    if (!this.online) throw new TransportError("offline");
  }

  async pull(since) {
    this.check();
    return structuredClone(this.server.pull(since));
  }

  async push(writes) {
    this.check();
    return structuredClone(this.server.push(writes));
  }
}

export const SERVER = "https://example.com/breezy/sync.php";

export function device(server, invite) {
  const store = new Store();
  const transport = new FakeTransport(server);
  const engine = new SyncEngine(store, { transport: () => transport });
  if (invite) store.join(invite);
  const edit = (id, change) => {
    const old = store.board(id);
    const now = structuredClone(old);
    change(now);
    store.apply(changes(old, now, id, store.orders(id)));
  };
  return { store, transport, engine, edit };
}

/** Two devices in one space with a board holding one card, both synced. */
export async function pair(newID) {
  const server = new FakeServer();
  const a = device(server);
  const invite = a.store.startSyncing(SERVER);
  const id = a.store.createBoard("Plans", { cards: [{ id: newID(), x: 0, y: 0, w: 240, text: "x", color: 1 }], lanes: [] });
  await a.engine.sync();
  const b = device(server, invite);
  await b.engine.sync();
  return { server, a, b, id };
}

export function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 2: Write the failing tests**

`web/test/engine.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer, SERVER, device, pair, mulberry } from "./helpers/fake-server.js";
import { statusLines } from "../sync/engine.js";
import { SpaceKeys } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { newID } from "../rules.js";
import * as R from "../rules.js";

test("a joining device gets the boards", async () => {
  const { a, b, id } = await pair(newID);
  assert.deepEqual(b.store.boards().map((x) => x.title), ["Plans"]);
  assert.deepEqual(b.store.board(id), a.store.board(id));
  assert.equal(a.engine.status.state, "synced");
  assert.deepEqual(a.store.pending(), []);
});

test("edits to different fields of a card combine", async () => {
  const { a, b, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].color = 3));
  b.edit(id, (x) => (x.cards[0].text = "y"));
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) assert.deepEqual(d.store.board(id).cards.map((c) => [c.color, c.text]), [[3, "y"]]);
});

test("text edited on both sides ends as two cards", async () => {
  const { a, b, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].text = "from a"));
  b.edit(id, (x) => (x.cards[0].text = "from b"));
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) assert.deepEqual(d.store.board(id).cards.map((c) => c.text).sort(), ["from a", "from b"]);
});

test("offline changes wait and are counted", async () => {
  const { a, id } = await pair(newID);
  a.transport.online = false;
  a.edit(id, (x) => R.addCard(x, 0, 0));
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Offline — 1 change waiting"]);
  a.transport.online = true;
  const calls = a.transport.calls;
  await a.engine.sync();
  assert.equal(a.transport.calls, calls);
  a.engine.reset();
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Synced just now"]);
  assert.deepEqual(a.store.pending(), []);
});

test("a refused token stops syncing", async () => {
  const { a } = await pair(newID);
  a.transport.failure = "unauthorized";
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Not in this space any more"]);
  const calls = a.transport.calls;
  await a.engine.sync();
  assert.equal(a.transport.calls, calls);
});

test("an unreadable record is skipped and counted", async () => {
  const { server, a } = await pair(newID);
  server.put(newID(), "AAAA");
  await a.engine.sync();
  assert.equal(a.store.state.unreadable, 1);
  assert.equal(a.store.state.cursor, server.version);
  assert.ok(statusLines(a.engine.status).includes("1 unreadable change"));
});

test("a record from a newer Breezy waits", async () => {
  const { server, a } = await pair(newID);
  const keys = await SpaceKeys.create(decode(a.store.state.space), decode(a.store.state.secret));
  const id = newID();
  const plain = new TextEncoder().encode(JSON.stringify({ format: 2, kind: "board", title: "Later" }));
  server.put(id, encode(await keys.seal(plain, decode(id))));
  await a.engine.sync();
  assert.ok(a.store.state.held[id]);
  assert.ok(!a.store.boards().some((x) => x.title === "Later"));
  assert.ok(statusLines(a.engine.status).includes("Update Breezy to see all changes"));
});

test("a card too long to sync stays here", async () => {
  const { a, id } = await pair(newID);
  const c = a.store.board(id).cards[0].id;
  a.edit(id, (x) => (x.cards[0].text = "x".repeat(70_000)));
  await a.engine.sync();
  assert.ok(statusLines(a.engine.status).includes("Card too long to sync"));
  assert.deepEqual(a.store.pending().map((p) => p.id), [c]);
});

test("pulls come in pages", async () => {
  const server = new FakeServer();
  const a = device(server);
  const invite = a.store.startSyncing(SERVER);
  const cards = Array.from({ length: 600 }, (_, i) => ({ id: newID(), x: 0, y: i * 24, w: 240, text: "t", color: 1 }));
  const id = a.store.createBoard("Big", { cards, lanes: [] });
  await a.engine.sync();
  const b = device(server, invite);
  await b.engine.sync();
  assert.equal(b.store.board(id).cards.length, 600);
});

test("four devices end the same", async () => {
  const server = new FakeServer();
  const first = device(server);
  const invite = first.store.startSyncing(SERVER);
  const id = first.store.createBoard("Plans");
  await first.engine.sync();
  const devices = [first, device(server, invite), device(server, invite), device(server, invite)];
  const rnd = mulberry(42);
  const int = (n) => Math.floor(rnd() * n);
  for (let step = 0; step < 300; step++) {
    const d = devices[int(4)];
    const roll = int(10);
    if (roll === 0) d.transport.online = !d.transport.online;
    else if (roll <= 3) {
      d.engine.reset();
      await d.engine.sync();
    } else {
      const pick = int(6), n = int(1000);
      d.edit(id, (b) => {
        const i = b.cards.length ? n % b.cards.length : -1;
        if (pick === 0) R.addCard(b, (n % 20) * 24, 0);
        else if (i < 0) return;
        else if (pick === 1) b.cards[i].text = `t${n}`;
        else if (pick === 2) b.cards[i].color = (n % 5) + 1;
        else if (pick === 3) Object.assign(b.cards[i], { x: b.cards[i].x + 24, y: b.cards[i].y + 24 });
        else if (pick === 4) b.cards.splice(i, 1);
        else b.cards.push(...b.cards.splice(i, 1));
      });
    }
  }
  for (const d of devices) {
    d.transport.online = true;
    d.engine.reset();
  }
  for (let round = 0; round < 3; round++) for (const d of devices) await d.engine.sync();
  const expected = devices[0].store.board(id);
  for (const d of devices) {
    assert.deepEqual(d.store.pending(), []);
    assert.deepEqual(d.store.board(id), expected);
  }
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test web/test/engine.test.js`
Expected: FAIL, cannot find `../../sync/engine.js`.

- [ ] **Step 4: Write `web/sync/engine.js`**

```js
// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at a time, as
// BreezyKit's SyncEngine; see the sync design.
import { SpaceKeys } from "./crypto.js";
import { encode, decode } from "./base64.js";
import { FORMAT } from "./records.js";

export const PAGE_SIZE = 500;
export const MAX_BLOB = 65536;
const MAX_REQUEST = 900_000;

export class TransportError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

/** The server's two calls; see server/sync.php. */
export class HttpTransport {
  constructor(server, space, token) {
    this.server = server;
    this.space = space;
    this.token = token;
  }

  async send(query, body) {
    const url = new URL(this.server);
    for (const [k, v] of Object.entries({ space: this.space, ...query })) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new TransportError(globalThis.navigator?.onLine === false ? "offline" : "unreachable");
    }
    if (res.status === 401) throw new TransportError("unauthorized");
    if (res.status === 413) throw new TransportError("tooLarge");
    if (!res.ok) throw new TransportError("unreachable");
    return res.json();
  }

  pull(since) {
    return this.send({ since });
  }

  push(writes) {
    return this.send({}, { writes });
  }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The status as the menus show it, a line each. */
export function statusLines(s, now = Date.now()) {
  const minutes = Math.floor((now - (s.at ?? now)) / 60_000);
  const out = [{
    local: "Not syncing",
    synced: minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`,
    offline: s.waiting ? `Offline — ${count(s.waiting, "change", "changes")} waiting` : "Offline",
    unreachable: "Can’t reach server",
    notInSpace: "Not in this space any more",
  }[s.state]];
  if (s.unreadable) out.push(count(s.unreadable, "unreadable change", "unreadable changes"));
  if (s.held) out.push("Update Breezy to see all changes");
  if (s.tooLong) out.push("Card too long to sync");
  return out;
}

export class SyncEngine {
  constructor(store, { transport = (state, keys) => new HttpTransport(state.server, state.space, encode(keys.token)), now = () => Date.now() } = {}) {
    this.store = store;
    this.makeTransport = transport;
    this.now = now;
    this.status = { state: "local", at: null, waiting: 0, unreadable: 0, held: 0, tooLong: 0 };
    this.onStatus = () => {};
    /** Called before merging, so that edits not yet in the store get there first. */
    this.flushLocal = () => {};
    this.running = null;
    this.again = false;
    this.stopped = false;
    this.heldTried = false;
    this.failures = 0;
    this.retryAt = 0;
    this.tooLong = 0;
    this.timer = null;
    this.keys = null;
    this.keysFor = null;
  }

  /** One cycle; a call during a cycle runs another after it. */
  async sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /** A cycle a second from now, once however many changes come meanwhile. */
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 1000);
  }

  /** Forgets a back-off and a refused token, as after joining a space. */
  reset() {
    this.failures = 0;
    this.retryAt = 0;
    this.stopped = false;
    this.heldTried = false;
  }

  async keysOf({ space, secret }) {
    const k = `${space}|${secret}`;
    if (this.keysFor !== k) {
      this.keys = await SpaceKeys.create(decode(space), decode(secret));
      this.keysFor = k;
    }
    return this.keys;
  }

  async cycle() {
    const state = this.store.state;
    if (!this.store.syncing) return this.update("local");
    if (this.stopped || this.retryAt > this.now()) return;
    const space = state.space;
    const same = () => this.store.state.space === space;
    try {
      const keys = await this.keysOf(state);
      const transport = this.makeTransport(state, keys);
      this.flushLocal();
      if (!this.heldTried) {
        this.heldTried = true;
        await this.retryHeld(keys);
      }
      for (;;) {
        const page = await transport.pull(this.store.state.cursor);
        if (!same()) return;
        const items = await this.decodeAll(page.records, keys);
        this.flushLocal();
        this.store.merge(items);
        this.store.advance(page.cursor);
        if (page.records.length < PAGE_SIZE) break;
      }
      let refusals = 0;
      for (let round = 0; round < 10; round++) {
        this.flushLocal();
        const { writes, sent } = await this.outgoing(keys);
        if (!writes.length) break;
        const result = await transport.push(writes);
        if (!same()) return;
        for (const a of result.accepted) if (sent.has(a.id)) this.store.accepted(a.id, a.version, sent.get(a.id));
        if (!result.refused.length) continue;
        const items = await this.decodeAll(result.refused, keys);
        this.flushLocal();
        this.store.merge(items);
        if (++refusals === 3) throw new TransportError("unreachable");
      }
      this.failures = 0;
      this.retryAt = 0;
      this.update("synced");
    } catch (error) {
      if (error?.kind === "unauthorized") {
        this.stopped = true;
        return this.update("notInSpace");
      }
      if (!(error instanceof TransportError)) console.warn("sync failed", error);
      this.failures++;
      this.retryAt = this.now() + Math.min(60, 5 * 2 ** (this.failures - 1)) * 1000;
      this.update(error?.kind === "offline" ? "offline" : "unreachable");
    }
  }

  async decodeOne(p, keys) {
    let record;
    try {
      record = JSON.parse(new TextDecoder().decode(await keys.open(decode(p.blob), decode(p.id))));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not a record");
    } catch {
      this.store.noteUnreadable();
      return null;
    }
    if ((record.format ?? 0) > FORMAT) {
      this.store.hold(p.id, p.version, p.blob);
      return null;
    }
    return { id: p.id, version: p.version, record };
  }

  async decodeAll(items, keys) {
    const out = [];
    for (const p of items) {
      const r = await this.decodeOne(p, keys);
      if (r) out.push(r);
    }
    return out;
  }

  /** Records held for a newer Breezy, which this one may now read. */
  async retryHeld(keys) {
    const ready = [];
    for (const [id, h] of Object.entries(this.store.state.held)) {
      this.store.release(id);
      const r = await this.decodeOne({ id, version: h.version, blob: h.blob }, keys);
      if (r) ready.push(r);
    }
    this.store.merge(ready);
  }

  async outgoing(keys) {
    const writes = [], sent = new Map();
    let size = 0;
    this.tooLong = 0;
    for (const p of this.store.pending()) {
      const id = decode(p.id);
      if (id?.length !== 16) continue;
      const blob = await keys.seal(new TextEncoder().encode(JSON.stringify(p.record)), id);
      if (blob.length > MAX_BLOB) {
        this.tooLong++;
        continue;
      }
      const w = { id: p.id, base: p.base, blob: encode(blob) };
      size += w.blob.length + 64;
      if (size > MAX_REQUEST) break;
      writes.push(w);
      sent.set(p.id, p.record);
    }
    return { writes, sent };
  }

  update(state) {
    this.status = {
      state, at: state === "synced" ? this.now() : this.status.at, waiting: this.store.pending().length,
      unreadable: this.store.state.unreadable, held: Object.keys(this.store.state.held).length, tooLong: this.tooLong,
    };
    this.onStatus(this.status);
  }
}
```

- [ ] **Step 5: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web
git commit --message "Pull, merge and push a space's records on the web" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 14: The server

**Files:**
- Create: `server/sync.php`, `server/schema.sql`, `server/config.example.php`, `server/.htaccess`, `server/test.sh`, `server/dev.sh`, `server/test/sync.test.mjs`
- Create: `BreezyKit/Tests/BreezyKitTests/HTTPTransportTests.swift`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the wire types of Task 7 and Task 13, `web/sync/store.js` and `engine.js` (for the end-to-end test)
- Produces: `GET sync.php?space=S&since=N` and `POST sync.php?space=S` as the spec's table; `BREEZY_CONFIG` names the config file, else `server/config.php`

- [ ] **Step 1: Make sure PHP is there**

Run: `php --version`
If it is missing: `brew install php`. Its builds include `pdo_sqlite`, which the tests use.

- [ ] **Step 2: Write the schema, config example, .htaccess and scripts**

`server/schema.sql` (valid in MySQL and SQLite):

```sql
CREATE TABLE spaces (id BINARY(16) PRIMARY KEY, token_hash BINARY(32) NOT NULL, version BIGINT NOT NULL);
CREATE TABLE records (space BINARY(16) NOT NULL, id BINARY(16) NOT NULL, version BIGINT NOT NULL, data MEDIUMBLOB NOT NULL,
                      PRIMARY KEY (space, id));
CREATE INDEX records_by_version ON records (space, version);
```

`server/config.example.php`:

```php
<?php
// Copy to config.php, which git ignores, and fill in the database.
return ['dsn' => 'mysql:host=localhost;dbname=breezy;charset=utf8mb4', 'user' => 'breezy', 'password' => ''];
```

`server/.htaccess`:

```apache
# Apache with PHP as CGI or FPM drops the Authorization header unless told to pass it on.
CGIPassAuth On
```

`server/test.sh`:

```zsh
#!/bin/zsh
# Runs server/test against sync.php on PHP's built-in server with a throwaway SQLite database, then the
# Mac's HTTP client against it: server/test.sh
set -e
cd ${0:A:h}
dir=$(mktemp -d)
trap 'kill $pid 2>/dev/null; rm -rf $dir' EXIT
php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents("schema.sql"));' $dir/test.db
print -r -- "<?php return ['dsn' => 'sqlite:$dir/test.db'];" > $dir/config.php
BREEZY_CONFIG=$dir/config.php php -S 127.0.0.1:58566 -t . >$dir/php.log 2>&1 &
pid=$!
sleep 1
export BREEZY_URL=http://127.0.0.1:58566/sync.php
node --test test/*.test.mjs || { cat $dir/php.log; exit 1 }
swift test --package-path ../BreezyKit --filter HTTPTransportTests
```

`server/dev.sh`:

```zsh
#!/bin/zsh
# Serves sync.php at http://127.0.0.1:58566/sync.php with a SQLite database in build/, for trying sync
# between the Mac app and the web app on this Mac: server/dev.sh
set -e
cd ${0:A:h}
mkdir -p ../build
db=${0:A:h:h}/build/sync-dev.db
[[ -f $db ]] || php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents("schema.sql"));' $db
print -r -- "<?php return ['dsn' => 'sqlite:$db'];" > ../build/sync-dev-config.php
BREEZY_CONFIG=${0:A:h:h}/build/sync-dev-config.php exec php -S 127.0.0.1:58566 -t .
```

Run: `chmod +x server/test.sh server/dev.sh`

Append to `.gitignore`:

```
server/config.php
```

- [ ] **Step 3: Write the failing server tests**

`server/test/sync.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ = process.env.BREEZY_URL;
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const rand = (n) => b64(crypto.getRandomValues(new Uint8Array(n)));

function client(space = rand(16), token = rand(32)) {
  const call = async (method, query = {}, body, headers = {}) => {
    const url = new URL(URL_);
    for (const [k, v] of Object.entries({ space, ...query })) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body && (typeof body === "string" ? body : JSON.stringify(body)),
    });
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body: json, headers: res.headers };
  };
  return { space, token, call, pull: (since = 0) => call("GET", { since }), push: (writes) => call("POST", {}, { writes }) };
}

test("the first write makes the space, and a pull gets it back", async () => {
  const c = client();
  const w = { id: rand(16), base: 0, blob: rand(40) };
  const pushed = await c.push([w]);
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.body, { accepted: [{ id: w.id, version: 1 }], refused: [] });
  assert.deepEqual((await c.pull()).body, { records: [{ id: w.id, version: 1, blob: w.blob }], cursor: 1 });
  assert.deepEqual((await c.pull(1)).body, { records: [], cursor: 1 });
});

test("a write on a stale base is refused with what is stored", async () => {
  const c = client();
  const id = rand(16), first = rand(40);
  await c.push([{ id, base: 0, blob: first }]);
  await c.push([{ id, base: 1, blob: rand(40) }]);
  const r = await c.push([{ id, base: 1, blob: rand(40) }]);
  assert.deepEqual(r.body.accepted, []);
  assert.equal(r.body.refused[0].version, 2);
});

test("a wrong token can neither read nor write", async () => {
  const c = client();
  await c.push([{ id: rand(16), base: 0, blob: rand(40) }]);
  const other = client(c.space);
  assert.equal((await other.pull()).status, 401);
  assert.equal((await other.push([{ id: rand(16), base: 0, blob: rand(40) }])).status, 401);
  assert.equal((await c.call("GET", {}, undefined, { Authorization: "Bearer nope" })).status, 401);
});

test("an unknown space reads as empty", async () => {
  assert.deepEqual((await client().pull(7)).body, { records: [], cursor: 7 });
});

test("pulls come in pages of 500", async () => {
  const c = client();
  await c.push(Array.from({ length: 501 }, () => ({ id: rand(16), base: 0, blob: rand(40) })));
  const first = await c.pull();
  assert.equal(first.body.records.length, 500);
  assert.equal(first.body.cursor, 500);
  assert.equal((await c.pull(500)).body.records.length, 1);
});

test("a record the server lost is written again", async () => {
  const c = client();
  const id = rand(16);
  assert.deepEqual((await c.push([{ id, base: 5, blob: rand(40) }])).body.accepted, [{ id, version: 1 }]);
});

test("what is too big is refused", async () => {
  const c = client();
  assert.equal((await c.push([{ id: rand(16), base: 0, blob: rand(65_537) }])).status, 413);
  const writes = Array.from({ length: 20 }, () => ({ id: rand(16), base: 0, blob: rand(60_000) }));
  assert.equal((await c.push(writes)).status, 413);
});

test("malformed requests are refused", async () => {
  const c = client();
  assert.equal((await client("short").pull()).status, 400);
  assert.equal((await c.push([{ id: "short", base: 0, blob: rand(40) }])).status, 400);
  assert.equal((await c.push([{ id: rand(16), base: -1, blob: rand(40) }])).status, 400);
  assert.equal((await c.push([{ id: rand(16), base: 0, blob: rand(8) }])).status, 400);
  assert.equal((await c.call("POST", {}, "not json")).status, 400);
  assert.equal((await c.call("GET", { since: "x" })).status, 400);
});

test("only the app's pages may call from a browser", async () => {
  const c = client();
  const ok = await c.call("OPTIONS", {}, undefined, { Origin: "https://arlol.github.io" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://arlol.github.io");
  const other = await c.call("OPTIONS", {}, undefined, { Origin: "https://example.com" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("the web app's engine syncs through the server", async () => {
  const { Store } = await import("../../web/sync/store.js");
  const { SyncEngine } = await import("../../web/sync/engine.js");
  const a = new Store();
  const invite = a.startSyncing(URL_);
  const id = a.createBoard("Over HTTP");
  const ea = new SyncEngine(a);
  await ea.sync();
  assert.equal(ea.status.state, "synced");
  const b = new Store();
  b.join(invite);
  await new SyncEngine(b).sync();
  assert.equal(b.title(id), "Over HTTP");
});
```

`BreezyKit/Tests/BreezyKitTests/HTTPTransportTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

/// Runs only from server/test.sh, which serves sync.php and sets BREEZY_URL.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["BREEZY_URL"] != nil))
@MainActor struct HTTPTransportTests {
  @Test func syncsThroughTheServer() async {
    let url = ProcessInfo.processInfo.environment["BREEZY_URL"]!
    let a = Store()
    let invite = a.startSyncing(server: url)
    let id = a.createBoard(title: "Over HTTP", contents: board([card(newID(), 0, 0, "Hi")]))
    let ea = SyncEngine(store: a)
    await ea.sync()
    #expect(ea.status.state == .synced)
    let b = Store()
    b.join(invite)
    await SyncEngine(store: b).sync()
    #expect(b.title(of: id) == "Over HTTP")
    #expect(b.board(id) == a.board(id))
  }
}
```

- [ ] **Step 4: Run them to see them fail**

Run: `server/test.sh`
Expected: FAIL. PHP's server answers 404 for `sync.php`, and the tests report status mismatches.

- [ ] **Step 5: Write `server/sync.php`**

```php
<?php
// Breezy's sync server: keeps each space's records, encrypted on the devices, and hands back those
// changed since a version. See docs/superpowers/specs/2026-10-08-breezy-sync-design.md.
declare(strict_types=1);

const PAGE = 500;
const MAX_BLOB = 65536;
const MAX_REQUEST = 1048576;
const ORIGINS = ['https://arlol.github.io', 'http://localhost:58565'];

function reply(int $status, ?array $body = null): void {
  http_response_code($status);
  if ($body !== null) {
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
  }
  exit;
}

function b64d(mixed $s): ?string {
  if (!is_string($s) || !preg_match('/^[A-Za-z0-9_-]*$/', $s)) return null;
  $t = strtr($s, '-_', '+/');
  $d = base64_decode(str_pad($t, (int)ceil(strlen($t) / 4) * 4, '='), true);
  return $d === false ? null : $d;
}

function b64e(string $d): string {
  return rtrim(strtr(base64_encode($d), '+/', '-_'), '=');
}

function bytes(mixed $s, int $length): ?string {
  $d = b64d($s);
  return $d !== null && strlen($d) === $length ? $d : null;
}

function query(PDO $db, string $sql, array $params): PDOStatement {
  $st = $db->prepare($sql);
  foreach (array_values($params) as $i => $v) $st->bindValue($i + 1, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_LOB);
  $st->execute();
  return $st;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ORIGINS, true)) {
  header("Access-Control-Allow-Origin: $origin");
  header('Access-Control-Allow-Headers: Authorization, Content-Type');
  header('Access-Control-Allow-Methods: GET, POST');
  header('Access-Control-Max-Age: 86400');
}
header('Vary: Origin');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') reply(204);

$space = bytes($_GET['space'] ?? null, 16);
if ($space === null) reply(400, ['error' => 'space']);
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
  ?? (function_exists('getallheaders') ? (getallheaders()['Authorization'] ?? '') : '');
$token = preg_match('/^Bearer ([A-Za-z0-9_-]+)$/', $auth, $m) ? bytes($m[1], 32) : null;
if ($token === null) reply(401);
$hash = hash('sha256', $token, true);

$config = require (getenv('BREEZY_CONFIG') ?: __DIR__ . '/config.php');
$db = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$lock = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';

if ($method === 'GET') {
  $since = filter_var($_GET['since'] ?? '0', FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
  if ($since === false) reply(400, ['error' => 'since']);
  $row = query($db, 'SELECT token_hash FROM spaces WHERE id = ?', [$space])->fetch(PDO::FETCH_ASSOC);
  if ($row && !hash_equals($row['token_hash'], $hash)) reply(401);
  $records = [];
  if ($row) {
    $st = query($db, 'SELECT id, version, data FROM records WHERE space = ? AND version > ? ORDER BY version LIMIT ' . PAGE, [$space, $since]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $records[] = ['id' => b64e($r['id']), 'version' => (int)$r['version'], 'blob' => b64e($r['data'])];
    }
  }
  reply(200, ['records' => $records, 'cursor' => $records ? $records[count($records) - 1]['version'] : $since]);
}

if ($method !== 'POST') reply(405);
$body = file_get_contents('php://input', false, null, 0, MAX_REQUEST + 1);
if (strlen($body) > MAX_REQUEST) reply(413);
$request = json_decode($body, true);
$list = is_array($request) ? ($request['writes'] ?? null) : null;
if (!is_array($list) || array_values($list) !== $list) reply(400, ['error' => 'writes']);
$writes = [];
foreach ($list as $w) {
  $id = is_array($w) ? bytes($w['id'] ?? null, 16) : null;
  $data = is_array($w) ? b64d($w['blob'] ?? null) : null;
  $base = is_array($w) ? ($w['base'] ?? null) : null;
  if ($id === null || $data === null || !is_int($base) || $base < 0 || strlen($data) < 28) reply(400, ['error' => 'write']);
  if (strlen($data) > MAX_BLOB) reply(413);
  $writes[] = [$id, $base, $data];
}

$db->beginTransaction();
$row = query($db, "SELECT token_hash, version FROM spaces WHERE id = ?$lock", [$space])->fetch(PDO::FETCH_ASSOC);
if (!$row) {
  query($db, 'INSERT INTO spaces (id, token_hash, version) VALUES (?, ?, 0)', [$space, $hash]);
  $version = 0;
} elseif (!hash_equals($row['token_hash'], $hash)) {
  $db->rollBack();
  reply(401);
} else {
  $version = (int)$row['version'];
}
$accepted = [];
$refused = [];
foreach ($writes as [$id, $base, $data]) {
  $stored = query($db, 'SELECT version, data FROM records WHERE space = ? AND id = ?', [$space, $id])->fetch(PDO::FETCH_ASSOC);
  // a record the server does not have is taken whatever its base, so that devices can refill a lost database
  if ($stored && (int)$stored['version'] !== $base) {
    $refused[] = ['id' => b64e($id), 'version' => (int)$stored['version'], 'blob' => b64e($stored['data'])];
    continue;
  }
  $version++;
  $sql = $stored
    ? 'UPDATE records SET version = ?, data = ? WHERE space = ? AND id = ?'
    : 'INSERT INTO records (version, data, space, id) VALUES (?, ?, ?, ?)';
  query($db, $sql, [$version, $data, $space, $id]);
  $accepted[] = ['id' => b64e($id), 'version' => $version];
}
query($db, 'UPDATE spaces SET version = ? WHERE id = ?', [$version, $space]);
$db->commit();
reply(200, ['accepted' => $accepted, 'refused' => $refused]);
```

- [ ] **Step 6: Run the server tests**

Run: `server/test.sh`
Expected: every node test passes, then `HTTPTransportTests` passes. If a test that reads blobs back fails, check that the SQLite build hands blobs back as strings; `php -r 'var_dump(PDO::getAvailableDrivers());'` must list `sqlite`.

- [ ] **Step 7: Commit**

```bash
git add server .gitignore BreezyKit/Tests/BreezyKitTests/HTTPTransportTests.swift
git commit --message "Add the sync server" --message "One PHP file and two tables: conditional writes, pulls after a version, nothing it can read." --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 15: The web app keeps its boards and lists them

**Files:**
- Create: `web/library.js`, `web/sheet.js`
- Modify: `web/app.js` (add `load`), `web/main.js`, `web/ui.js` (`act` cases), `web/index.html`, `web/style.css`

**Interfaces:**
- Consumes: Store, Saver, loadState/saveState, Binding, `withFreshIDs`, `sampleBoard`, `Model.replace`
- Produces: `App.load(board)`, `app.library`, `ask(options) -> Promise<{ value } | { danger: true } | null>`
- Produces: `class Library { static open(app); store; saver; readOnly; id; binding; open(id); showList(); renderList(); newBoard(); edit(id); restack(board) }`; Task 16 adds `engine`

- [ ] **Step 1: Add the list, the sheet and the back button to `web/index.html`**

In `#top`'s first `.pill`, before the undo button:

```html
    <button data-act="boards" aria-label="Boards" hidden><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
```

After `</header>` (the `#top` header):

```html
<section id="boards" hidden>
  <header class="boards-top">
    <h1>Boards</h1>
    <div class="pill"><button data-act="more" aria-label="More"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button></div>
  </header>
  <ul class="boards-list"></ul>
  <button data-act="new-board" class="boards-new strong">New Board</button>
</section>

<div id="sheet" hidden>
  <form class="sheet-card">
    <p class="sheet-title"></p>
    <p class="sheet-message"></p>
    <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="sheet-buttons">
      <button type="button" data-sheet="cancel">Cancel</button>
      <button type="button" data-sheet="danger" class="danger"></button>
      <button type="submit" data-sheet="ok" class="strong">OK</button>
    </div>
  </form>
</div>
```

Give `<body>` the attribute `data-screen="board"`.

- [ ] **Step 2: Style them in `web/style.css`**

Append:

```css
body[data-screen="boards"] :is(#board, #top, #bottom, #zoom-level, #find, #keys) { display: none !important; }
#boards {
  position: fixed; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: calc(env(safe-area-inset-top) + 8px) 16px calc(env(safe-area-inset-bottom) + 24px);
}
body[data-screen="board"] #boards { display: none; }
.boards-top { display: flex; align-items: center; justify-content: space-between; min-height: 44px; }
.boards-top h1 { margin: 0; font-size: 28px; line-height: 34px; font-weight: 700; }
.boards-list { list-style: none; margin: 16px 0 0; padding: 0; border-radius: 22px; overflow: hidden; background: var(--sheet); box-shadow: var(--lift); }
.boards-list li { display: flex; align-items: center; border-top: 1px solid var(--hairline); }
.boards-list li:first-child { border-top: 0; }
.boards-list .open { flex: 1; min-width: 0; height: 52px; padding: 0 16px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boards-list .edit { width: 52px; height: 52px; color: var(--ink3); }
.boards-new { display: block; width: 100%; height: 52px; margin-top: 16px; border-radius: 999px; background: var(--glass); box-shadow: var(--lift); }
#sheet { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgb(0 0 0 / 0.2); }
.sheet-card { box-sizing: border-box; width: min(100%, 320px); padding: 20px 16px 12px; border-radius: 26px; background: var(--sheet); box-shadow: var(--lift); text-align: center; }
.sheet-title { margin: 0; font-weight: 600; }
.sheet-message { margin: 4px 0 0; color: var(--ink2); font-size: 15px; line-height: 20px; white-space: pre-line; }
.sheet-card input {
  box-sizing: border-box; width: 100%; height: 40px; margin-top: 14px; padding: 0 12px; font: inherit; color: var(--ink);
  background: var(--press); border: 0; border-radius: 12px; outline: none; -webkit-appearance: none; appearance: none;
  -webkit-user-select: text; user-select: text;
}
.sheet-buttons { display: flex; gap: 8px; margin-top: 16px; }
.sheet-buttons button { flex: 1; height: 44px; border-radius: 999px; background: var(--press); color: var(--ink); }
.sheet-buttons .danger { color: #d93a2b; }
@media (prefers-color-scheme: dark) { .sheet-buttons .danger { color: #ff6b5e; } }
```

- [ ] **Step 3: Write `web/sheet.js`**

```js
/**
 * A small sheet over everything, as an iOS alert: a title, maybe a line of text and a field, and buttons. Resolves to
 * { value } for OK, { danger: true } for the red button, or null for Cancel. Passing `value` shows the field.
 */
export function ask({ title, message = "", value, placeholder = "", ok = "OK", danger = null, cancel = "Cancel" }) {
  const sheet = document.getElementById("sheet");
  const form = sheet.querySelector("form");
  const field = sheet.querySelector("input");
  const [cancelButton, dangerButton, okButton] = ["cancel", "danger", "ok"].map((k) => sheet.querySelector(`[data-sheet="${k}"]`));
  sheet.querySelector(".sheet-title").textContent = title;
  const text = sheet.querySelector(".sheet-message");
  text.textContent = message;
  text.hidden = !message;
  field.hidden = value === undefined;
  field.value = value ?? "";
  field.placeholder = placeholder;
  for (const [b, label] of [[okButton, ok], [dangerButton, danger], [cancelButton, cancel]]) {
    b.textContent = label ?? "";
    b.hidden = !label;
  }
  sheet.hidden = false;
  if (!field.hidden) field.focus();
  return new Promise((resolve) => {
    const done = (result) => {
      sheet.hidden = true;
      field.blur();
      form.onsubmit = dangerButton.onclick = cancelButton.onclick = null;
      resolve(result);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      done({ value: field.value });
    };
    dangerButton.onclick = () => done({ danger: true });
    cancelButton.onclick = () => done(null);
  });
}
```

- [ ] **Step 4: Add `App.load` to `web/app.js`**

After `get heightOf()`:

```js
  /** Shows `board` in place of the one shown, with no undo history. */
  load(board) {
    this.endEditing();
    this.turn(null);
    this.ui.closeFind();
    this.state.selection = new Set();
    this.model.replace(board);
    this.view.setCamera({ x: 16, y: this.ui.area().top + 16, zoom: 0.75 });
  }
```

- [ ] **Step 5: Write `web/library.js`**

```js
import { Store, withFreshIDs } from "./sync/store.js";
import { Saver } from "./sync/saver.js";
import { loadState, saveState } from "./sync/idb.js";
import { Binding } from "./binding.js";
import { sampleBoard } from "./sample.js";
import { ask } from "./sheet.js";
import * as R from "./rules.js";

/** The boards on this device: the store in IndexedDB, the board list and the open board. */
export class Library {
  static async open(app) {
    let state = null, readOnly = false;
    try {
      state = await loadState();
    } catch (error) {
      // saving now could overwrite boards that failed to load
      console.warn("boards not loaded", error);
      readOnly = true;
    }
    const lib = new Library(app, new Store(state ?? undefined), readOnly);
    if (!state) lib.store.createBoard("Sample", withFreshIDs(sampleBoard()));
    lib.showList();
    return lib;
  }

  constructor(app, store, readOnly) {
    this.app = app;
    this.store = store;
    this.readOnly = readOnly;
    this.id = null;
    this.binding = null;
    app.library = this;
    this.saver = new Saver(() => saveState(this.store.state));
    this.saver.enabled = !readOnly;
    store.onDirty = () => this.saver.schedule();
    store.onChange = (boards, remote) => this.changed(boards, remote);
    const change = app.model.onChange;
    app.model.onChange = () => {
      change();
      this.binding?.changed();
    };
    this.restack = (b) => R.gravity(b, (id) => {
      const c = R.card(b, id);
      return c ? app.view.frontHeight(c.text, c.w) : 0;
    });
    document.addEventListener("visibilitychange", () => document.hidden && this.saver.flush());
    addEventListener("pagehide", () => this.saver.flush());
    document.querySelector('[data-act="boards"]').hidden = false;
  }

  changed(boards, remote) {
    if (this.id && boards.has(this.id)) {
      if (this.store.title(this.id) === null) return this.showList();
      if (remote) this.binding.pull();
    }
    if (!this.id) this.renderList();
  }

  open(id) {
    this.binding?.flush();
    this.binding = null;
    this.id = id;
    const b = this.store.board(id);
    this.restack(b);
    document.body.dataset.screen = "board";
    this.app.load(b);
    this.binding = new Binding(this.store, this.app.model, id, this.restack);
  }

  showList() {
    this.app.endEditing();
    this.binding?.flush();
    this.binding = null;
    this.id = null;
    document.body.dataset.screen = "boards";
    this.renderList();
  }

  renderList() {
    const ul = document.querySelector(".boards-list");
    ul.replaceChildren(...this.store.boards().map(({ id, title }) => {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.className = "open";
      open.textContent = title || "Untitled";
      open.addEventListener("click", () => this.open(id));
      const edit = document.createElement("button");
      edit.className = "edit";
      edit.setAttribute("aria-label", `Rename or delete ${title || "Untitled"}`);
      edit.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
      edit.addEventListener("click", () => this.edit(id));
      li.append(open, edit);
      return li;
    }));
    ul.hidden = !ul.children.length;
  }

  async newBoard() {
    const r = await ask({ title: "New Board", value: "", placeholder: "Name", ok: "Create" });
    const title = r?.value?.trim();
    if (title) this.open(this.store.createBoard(title));
  }

  async edit(id) {
    const title = this.store.title(id);
    const r = await ask({ title: "Rename Board", value: title, ok: "Rename", danger: "Delete Board" });
    if (r?.value?.trim() && r.value.trim() !== title) return this.store.renameBoard(id, r.value.trim());
    if (!r?.danger) return;
    const sure = await ask({
      title: `Delete “${title}”?`,
      message: this.store.syncing ? "It is deleted on every device in the space." : "This can’t be undone.",
      ok: null, danger: "Delete",
    });
    if (sure?.danger) this.store.deleteBoard(id);
  }
}
```

- [ ] **Step 6: Wire it in `web/main.js` and `web/ui.js`**

In `web/main.js`, replace the first two `const` lines after the imports and add the import:

```js
import { Library } from "./library.js";
```

```js
const params = new URLSearchParams(location.search);
// ?stress and ?demo show boards that are not kept, as before
const scratch = params.has("stress") ? stressBoard() : params.has("demo") ? sampleBoard() : null;
const app = new App(scratch ?? { cards: [], lanes: [] });
```

At the top of the `wheel` listener's callback, before `e.preventDefault()`:

```js
  if (document.body.dataset.screen === "boards") return;
```

At the top of the `keydown` listener's callback:

```js
  if (document.body.dataset.screen === "boards") return;
```

At the end of `main.js`:

```js
if (!scratch) await Library.open(app);
```

In `web/ui.js` `act(name, b)`, add these cases:

```js
      case "boards": return app.library?.showList();
      case "new-board": return app.library?.newBoard();
```

- [ ] **Step 7: Check it in a browser**

Run: `npx --yes live-server@1.2.2 web --port=58565 --no-browser` in the background, then open `http://localhost:58565/` in Chrome or the iOS simulator (`xcrun simctl openurl booted http://localhost:58565/`).

Check, and fix anything that differs:
1. The app opens on "Boards" with one board, "Sample". Tapping it shows the sample board, and ‹ goes back.
2. Move a card, go back, reload: the card stays where it was moved.
3. New Board → "Plans" → Create opens an empty board. It is listed after going back.
4. ⋯ on a row → Rename works. ⋯ → Delete Board → Delete removes it.
5. `?stress` and `?demo=turn` still show their boards, without the list or a back button.
6. On the list, arrow keys, `L` and the wheel do nothing to the hidden board.

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add web
git commit --message "Keep the web app's boards on the device and list them" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 16: Syncing from the web app

**Files:**
- Modify: `web/library.js`, `web/ui.js` (`act`, `updateSync`), `web/index.html` (the ⋯ menu), `web/style.css`

**Interfaces:**
- Consumes: `SyncEngine`, `statusLines` (Task 13), `inviteLink`, `parseInvite`, `validServer` (Task 11), `ask`
- Produces: `Library.engine`, `Library.startSyncing()`, `Library.join(text?)`, `Library.share()`, `Library.statusLines()`, `UI.updateSync()`

- [ ] **Step 1: Add the menu items in `web/index.html`**

Replace the `.menu.more` div:

```html
<div class="menu more" hidden>
  <p class="status">Not syncing</p>
  <button data-act="start-sync">Start Syncing</button>
  <button data-act="join">Join Space</button>
  <button data-act="share" hidden>Share Invite</button>
  <button data-act="version" data-version="dev">Version</button>
</div>
```

Append to `web/style.css`:

```css
.menu .status { margin: 0; padding: 8px 14px; color: var(--ink2); font-size: 15px; line-height: 20px; white-space: pre-line; }
```

- [ ] **Step 2: Add the actions to `web/ui.js`**

In `act(name, b)`:

```js
      case "start-sync": this.closeMenu(); return app.library?.startSyncing();
      case "join": this.closeMenu(); return app.library?.join();
      case "share": this.closeMenu(); return app.library?.share();
```

Add a method:

```js
  /** The ⋯ menu's sync status and the actions that fit it. */
  updateSync() {
    const lib = this.app.library;
    if (!lib) return;
    this.$(".menu.more .status").textContent = lib.statusLines().join("\n");
    this.$('[data-act="start-sync"]').hidden = lib.store.syncing;
    this.$('[data-act="share"]').hidden = !lib.store.syncing;
  }
```

- [ ] **Step 3: Give the library an engine**

In `web/library.js`, add imports:

```js
import { SyncEngine, statusLines } from "./sync/engine.js";
import { inviteLink, parseInvite, validServer } from "./sync/crypto.js";
```

In `Library.open`, after `lib.showList();`:

```js
    if (location.hash.includes("#join=")) {
      const text = location.href;
      history.replaceState(null, "", location.pathname + location.search);
      lib.join(text);
    }
    lib.engine.sync();
```

In the constructor, after `store.onChange = …`:

```js
    this.engine = new SyncEngine(store);
    this.engine.flushLocal = () => this.binding?.flush();
    this.engine.onStatus = () => app.ui.updateSync();
    setInterval(() => !document.hidden && this.id && this.engine.sync(), 5000);
    document.addEventListener("visibilitychange", () => document.hidden || this.engine.sync());
    app.ui.updateSync();
```

At the end of `changed(boards, remote)`:

```js
    if (!remote) this.engine.changed();
    this.app.ui.updateSync();
```

At the end of `open(id)`:

```js
    this.engine.sync();
```

Add the methods:

```js
  statusLines() {
    return [...(this.readOnly ? ["Boards can’t be saved on this device"] : []), ...statusLines(this.engine.status)];
  }

  async startSyncing() {
    const r = await ask({
      title: "Start Syncing",
      message: "The address of your Breezy server. Boards are encrypted on this device; the server can’t read them.",
      value: "", placeholder: "https://example.com/breezy/sync.php", ok: "Start",
    });
    const server = r?.value?.trim();
    if (!server) return;
    if (!validServer(server)) return ask({ title: "That isn’t a server address", message: "Use an https:// address ending in sync.php.", cancel: null });
    this.store.startSyncing(server);
    this.engine.reset();
    await this.engine.sync();
  }

  async join(text) {
    if (text === undefined) {
      const r = await ask({ title: "Join Space", message: "Paste the invite link from another device.", value: "", placeholder: "Invite link", ok: "Join" });
      if (!r) return;
      text = r.value;
    }
    const invite = parseInvite(text);
    if (!invite) return ask({ title: "That isn’t an invite link", message: "Copy the whole link from Share Invite on the other device.", cancel: null });
    const n = this.store.boards().length;
    if (n) {
      const sure = await ask({
        title: "Replace the boards here?",
        message: `Joining shows the space’s boards instead of the ${n === 1 ? "board" : `${n} boards`} on this device, which are deleted from it.`,
        ok: null, danger: "Join",
      });
      if (!sure?.danger) return;
    }
    this.showList();
    this.store.join(invite);
    this.engine.reset();
    await this.engine.sync();
  }

  async share() {
    const link = inviteLink(this.store.invite);
    try {
      await navigator.share({ url: link });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
    await navigator.clipboard?.writeText(link).catch(() => {});
    await ask({
      title: "Invite link copied",
      message: "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.",
      cancel: null,
    });
  }
```

`ask` with `cancel: null` shows only OK.

- [ ] **Step 4: Try two browsers against the dev server**

Run in the background: `server/dev.sh` and `npx --yes live-server@1.2.2 web --port=58565 --no-browser`.

In Chrome at `http://localhost:58565/`:
1. ⋯ shows "Not syncing". Start Syncing with `http://127.0.0.1:58566/sync.php`; ⋯ then shows "Synced just now" and Share Invite.
2. Share Invite: copy the link.
3. In a private window at `http://localhost:58565/`, ⋯ → Join Space, paste the link, confirm Join. The Sample board from the first window appears.
4. Move a card in one window; within 6 s it moves in the other while that window shows the board.
5. Edit the same card's text in both windows within a few seconds of each other: both end up showing two cards.
6. Stop `server/dev.sh`: within 10 s ⋯ shows "Can’t reach server". Restart it: the status returns to "Synced just now".
7. Opening `http://localhost:58565/` plus the link's `#join=…` part in a new private window offers to join directly.

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web
git commit --message "Start, join and share a space from the web app" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 17: Boards without files on the Mac

**Files:**
- Create: `Breezy/Library/Library.swift`, `Breezy/Library/BoardsWindowController.swift`
- Modify: `Breezy/Document/BoardDocument.swift` (rewrite), `Breezy/Window/BoardWindowController.swift`, `Breezy/Canvas/CanvasView.swift` (add `restack`), `Breezy/App/AppDelegate.swift`, `Breezy/App/MainMenu.swift`, `Breezy/Support/DebugLaunch.swift`, `Breezy/Support/SelfTest.swift`, `BreezyUITests/BreezyUITests.swift`, `project.yml`, `scripts/make-icons.swift`
- Delete: `Breezy/Resources/Board.icns`

**Interfaces:**
- Consumes: `Store`, `StoreFile`, `BoardBinding`, `BoardFormat.decode`
- Produces: `@MainActor final class Library { static var shared: Library!; store; file; documents: [BoardDocument]; init(directory:) throws; open(_ id: String, display: Bool = true) -> BoardWindowController?; saveNow() }`
- Produces: `BoardDocument(boardID:store:)` with `boardID`, `model`, `binding`, `windowController`; `BoardRestorer`; `BoardsWindowController.shared`; `CanvasView.restack(_:)`; `DebugLaunch.storeDirectory`; `AppDelegate.newBoard(_:)`, `showBoards(_:)`
- Notification names: `.boardsChanged`

- [ ] **Step 1: Drop the document type**

In `project.yml`, delete the `CFBundleDocumentTypes` and `UTExportedTypeDeclarations` blocks under `info.properties`. Delete `Breezy/Resources/Board.icns`. In `scripts/make-icons.swift`, delete `func docIcon…` (line 51) and `icns("Board", docIcon)` (line 70), and change the header comment to "Draws the app icon and writes Breezy.icns into the directory given."

Run: `xcodegen generate && git diff --stat Breezy/Info.plist`
Expected: `Info.plist` loses its `CFBundleDocumentTypes` and `UTExportedTypeDeclarations`.

- [ ] **Step 2: Rewrite `Breezy/Document/BoardDocument.swift`**

```swift
import AppKit
import BreezyKit

/// One board's window and undo, without a file: the board lives in the library's store. AppKit's
/// documents still give the window its undo manager and title.
final class BoardDocument: NSDocument {
  let boardID: String
  let model: BoardModel
  let binding: BoardBinding

  init(boardID: String, store: Store) {
    self.boardID = boardID
    // stacked as this Mac measures text; the store keeps the positions as they came
    var b = store.board(boardID)
    let heights = Dictionary(uniqueKeysWithValues: b.cards.map { ($0.id, Double(TextMetrics.frontHeight($0.text, width: CGFloat($0.w)))) })
    b.gravity { heights[$0] ?? 2 * Metrics.grid }
    model = BoardModel(board: b)
    binding = BoardBinding(id: boardID, model: model, store: store)
    super.init()
    undoManager = model.undoManager
  }

  var windowController: BoardWindowController? { windowControllers.first as? BoardWindowController }

  override func makeWindowControllers() {
    let wc = BoardWindowController(model: model, boardID: boardID)
    addWindowController(wc)
    binding.restack = { [weak wc] b in wc?.canvas.restack(&b) }
    wc.window?.identifier = NSUserInterfaceItemIdentifier("board")
    wc.window?.restorationClass = BoardRestorer.self
  }

  override var displayName: String! {
    get { MainActor.assumeIsolated { Library.shared.store.title(of: boardID) } ?? "Board" }
    set {}
  }

  // the store saves; a document never counts as edited, so closing never asks
  override func updateChangeCount(_ change: NSDocument.ChangeType) {}
  override var isDocumentEdited: Bool { false }

  override func close() {
    windowController?.canvas.endEditing()
    binding.flush()
    super.close()
  }
}

/// Brings back the board windows open at quit; a window's state holds its board's id.
final class BoardRestorer: NSObject, NSWindowRestoration {
  static func restoreWindow(
    withIdentifier identifier: NSUserInterfaceItemIdentifier, state: NSCoder, completionHandler: @escaping (NSWindow?, Error?) -> Void
  ) {
    let window = MainActor.assumeIsolated {
      (state.decodeObject(of: NSString.self, forKey: "board") as String?).flatMap { Library.shared.open($0, display: false)?.window }
    }
    completionHandler(window, window == nil ? CocoaError(.fileNoSuchFile) : nil)
  }
}
```

- [ ] **Step 3: Give the window its board id, and the canvas `restack`**

In `Breezy/Window/BoardWindowController.swift`, add `let boardID: String`, change `init(model: BoardModel)` to `init(model: BoardModel, boardID: String)` and set `self.boardID = boardID` before `canvas = CanvasView(model: model)`. In `window(_:willEncodeRestorableState:)`, add:

```swift
    state.encode(boardID as NSString, forKey: "board")
```

In `Breezy/Canvas/CanvasView.swift`, after `height(_:)`:

```swift
  /// Stacks `b` as this canvas would, measuring only cards whose text or width changed.
  func restack(_ b: inout Board) {
    let shown = Dictionary(board.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var h: [String: Double] = [:]
    for c in b.cards {
      let old = shown[c.id]
      h[c.id] = old?.text == c.text && old?.w == c.w ? height(c.id) : Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w)))
    }
    b.gravity { h[$0] ?? 2 * Metrics.grid }
  }
```

- [ ] **Step 4: Write `Breezy/Library/Library.swift`**

```swift
import AppKit
import BreezyKit

extension Notification.Name {
  static let boardsChanged = Notification.Name("BreezyBoardsChanged")
}

/// The boards on this Mac: the store and its file, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let store: Store
  let file: StoreFile

  init(directory: URL) throws {
    file = StoreFile(url: directory.appendingPathComponent("space.json"))
    store = Store(state: try file.load() ?? SpaceState())
    store.onDirty = { [weak self] in self?.scheduleSave() }
    store.onChange = { [weak self] boards, remote in self?.changed(boards, remote: remote) }
    file.onError = { NSApp.presentError($0) }
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  private func scheduleSave() { file.scheduleSave { [store] in store.state } }

  /// Ends edits and writes the store before quitting.
  func saveNow() {
    for d in documents {
      d.windowController?.canvas.endEditing()
      d.binding.flush()
    }
    file.save(store.state, wait: true)
  }

  func changed(_ boards: Set<String>, remote: Bool) {
    for d in documents where boards.contains(d.boardID) {
      if store.title(of: d.boardID) == nil {
        d.close()
        continue
      }
      if remote { d.binding.pull() }
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
      guard store.title(of: id) != nil else { return nil }
      doc = BoardDocument(boardID: id, store: store)
      NSDocumentController.shared.addDocument(doc)
      doc.makeWindowControllers()
    }
    if display { doc.showWindows() }
    return doc.windowController
  }
}
```

- [ ] **Step 5: Write `Breezy/Library/BoardsWindowController.swift`**

```swift
import AppKit
import BreezyKit

/// The Boards window: every board in the store, to open, rename, add and delete.
@MainActor final class BoardsWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
  static let shared = BoardsWindowController()
  private let table = NSTableView()
  let status = NSTextField(labelWithString: "")
  private var boards: [(id: String, title: String)] = []

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Boards"
    window.minSize = NSSize(width: 280, height: 240)
    super.init(window: window)
    window.setFrameAutosaveName("Boards")
    table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title")))
    table.headerView = nil
    table.style = .inset
    table.rowHeight = 28
    table.dataSource = self
    table.delegate = self
    table.target = self
    table.doubleAction = #selector(openClicked)
    let scroll = NSScrollView()
    scroll.documentView = table
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
    reload()
  }

  required init?(coder: NSCoder) { fatalError() }

  func reload() {
    boards = Library.shared.store.boards
    table.reloadData()
  }

  func numberOfRows(in tableView: NSTableView) -> Int { boards.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let cell = NSTableCellView()
    let field = NSTextField(string: boards[row].title)
    field.isBordered = false
    field.drawsBackground = false
    field.isEditable = true
    field.delegate = self
    field.tag = row
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
    guard let field = obj.object as? NSTextField, boards.indices.contains(field.tag) else { return }
    let b = boards[field.tag]
    let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != b.title else {
      field.stringValue = b.title
      return
    }
    Library.shared.store.renameBoard(b.id, title)
  }

  @objc private func openClicked() {
    guard boards.indices.contains(table.clickedRow) else { return }
    Library.shared.open(boards[table.clickedRow].id)
  }

  /// Edit → Delete, ⌫ in the list and the − button.
  @objc func delete(_ sender: Any?) {
    guard boards.indices.contains(table.selectedRow), let window else { return NSSound.beep() }
    let b = boards[table.selectedRow]
    let alert = NSAlert()
    alert.messageText = "Delete “\(b.title)”?"
    alert.informativeText = Library.shared.store.state.invite == nil ? "This can’t be undone." : "It is deleted on every device in the space. This can’t be undone."
    alert.addButton(withTitle: "Delete").hasDestructiveAction = true
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in
      guard response == .alertFirstButtonReturn else { return }
      MainActor.assumeIsolated {
        Library.shared.documents.first { $0.boardID == b.id }?.close()
        Library.shared.store.deleteBoard(b.id)
      }
    }
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 51 || event.keyCode == 117 { delete(nil) } else { super.keyDown(with: event) }
  }
}
```

- [ ] **Step 6: Change the app delegate and the menus**

`Breezy/App/AppDelegate.swift`:

```swift
import AppKit
import BreezyKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
    // the boards open at quit come back on relaunch, whatever "Close windows when quitting an
    // application" says in System Settings; this app's own setting overrides that global one
    UserDefaults.standard.set(true, forKey: "NSQuitAlwaysKeepsWindows")
    let dir = DebugLaunch.storeDirectory
    do {
      Library.shared = try Library(directory: dir)
    } catch {
      let alert = NSAlert()
      alert.messageText = "Breezy can’t read its boards"
      alert.informativeText = "\(error.localizedDescription)\n\nThe file is left as it is: \(dir.appendingPathComponent("space.json").path)"
      alert.runModal()
      exit(1)
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DebugLaunch.start()
    if !DebugLaunch.active && Library.shared.documents.isEmpty { BoardsWindowController.shared.showWindow(nil) }
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { BoardsWindowController.shared.showWindow(nil) }
    return false
  }

  func applicationWillTerminate(_ notification: Notification) { Library.shared.saveNow() }

  @objc func newBoard(_ sender: Any?) {
    Library.shared.open(Library.shared.store.createBoard(title: "New Board"))
  }

  @objc func showBoards(_ sender: Any?) { BoardsWindowController.shared.showWindow(nil) }
}
```

In `Breezy/App/MainMenu.swift`, replace the File menu and add Boards to the Window menu:

```swift
    main.addItem(submenu("File", [
      item("New Board", #selector(AppDelegate.newBoard(_:)), "n"),
      .separator(),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ]))
```

```swift
    let window = submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("Boards", #selector(AppDelegate.showBoards(_:)), "b", [.command, .shift]),
      .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
```

Change the comment above `enum MainMenu` to "The menu bar, built in code."

- [ ] **Step 7: Load scripted checks' boards into a scratch store**

In `Breezy/Support/DebugLaunch.swift`, add `import BreezyKit`. In the doc comment, change "the app opens that board and no untitled one" to "the app loads that board's JSON into a store in a fresh temporary folder, or in -BreezyStore <dir>, and opens it". Add:

```swift
  /// Where the store lives: -BreezyStore <dir>, a fresh temporary folder for scripted checks, else
  /// Application Support.
  static let storeDirectory: URL = {
    if let dir = defaults.string(forKey: "BreezyStore") { return URL(fileURLWithPath: dir) }
    if active { return FileManager.default.temporaryDirectory.appendingPathComponent("breezy-\(UUID().uuidString)") }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Breezy")
  }()
```

In `start()`, replace the `NSDocumentController.shared.openDocument(…) { doc, _, error in` opening, the error check and the `guard let wc …` line with:

```swift
    let url = URL(fileURLWithPath: board)
    let loaded: Board
    do {
      loaded = try BoardFormat.decode(Data(contentsOf: url)).recentred(within: Double(CanvasView.origin) - 2_000)
    } catch {
      print("cannot open \(board): \(error.localizedDescription)")
      exit(1)
    }
    let id = MainActor.assumeIsolated { Library.shared.store.createBoard(title: url.deletingPathExtension().lastPathComponent, contents: loaded) }
    guard let wc = MainActor.assumeIsolated({ Library.shared.open(id) }), let window = wc.window else { exit(1) }
```

and remove the closure's closing `}`; the code that followed runs unchanged.

- [ ] **Step 8: Point the checks at the store**

In `Breezy/Support/SelfTest.swift`, replace `closeWhileEditing` and `closeBlankCard`:

```swift
  /// Closing while a card is being edited keeps its text in the store's file.
  fileprivate static func closeWhileEditing(_ d: Driver) {
    let name = "close-while-editing"
    let file = StoreFile(url: DebugLaunch.storeDirectory.appendingPathComponent("space.json"))
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type("Kept")
    d.window.performClose(nil)
    var tries = 0
    func poll() {
      let texts = ((try? file.load()) ?? nil)?.records.values.compactMap { $0.current.deleted ? nil : $0.current["text"]?.string } ?? []
      if texts.contains("Kept") { finish(name, nil) }
      tries += 1
      if tries > 25 { finish(name, "the store has no Kept: \(texts)") }
      d.later(0.2, poll)
    }
    d.later(0.2, poll)
  }
```

```swift
  /// Closing right after creating a card leaves no blank card in the store.
  fileprivate static func closeBlankCard(_ d: Driver) {
    let name = "close-blank-card"
    let file = StoreFile(url: DebugLaunch.storeDirectory.appendingPathComponent("space.json"))
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type(" ")
    d.window.performClose(nil)
    d.later(1.5) {
      guard let state = (try? file.load()) ?? nil else { finish(name, "no store file") }
      let cards = state.records.values.filter { $0.current.kind == "card" && !$0.current.deleted }
      finish(name, cards.isEmpty ? nil : "the store has \(cards.count) cards")
    }
  }
```

Keep each function's `extension SelfTest {` wrapper. Add `import BreezyKit` if the file lacks it.

In `BreezyUITests/BreezyUITests.swift`, have `open` pass a store folder and return it:

```swift
  /// Launches the app on a board written from `json` into a temporary file, with a store in a
  /// temporary folder; returns the board file and the store's file.
  @discardableResult
  func open(_ json: String) -> (board: URL, store: URL) {
    let tmp = FileManager.default.temporaryDirectory
    let url = tmp.appendingPathComponent(UUID().uuidString + ".breezy")
    let store = tmp.appendingPathComponent(UUID().uuidString)
    try! json.write(to: url, atomically: true, encoding: .utf8)
    app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-BreezyBoard", url.path, "-BreezyStore", store.path]
    app.launch()
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    return (url, store.appendingPathComponent("space.json"))
  }
```

In `testOpensABoard`, use `let url = open(…).board`. In `testClosingWhileEditingKeepsText`, use `let store = open(empty).store` and replace the last assertion:

```swift
    let deadline = Date().addingTimeInterval(5)
    var text = ""
    while Date() < deadline {
      text = (try? String(contentsOf: store, encoding: .utf8)) ?? ""
      if text.contains(#""text":"Kept""#) { break }
      Thread.sleep(forTimeInterval: 0.2)
    }
    XCTAssertTrue(text.contains(#""text":"Kept""#))
```

- [ ] **Step 9: Build and check**

`Library`, `SyncEngine` and `BoardsWindowController` are main-actor isolated. If the compiler reports a main actor-isolated call in a synchronous nonisolated context, the caller is a nonisolated Swift type or an AppKit override the SDK leaves nonisolated: wrap that call in `MainActor.assumeIsolated { … }`, as `DebugLaunch` and `BoardRestorer` do.

Run: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`.

Run: `scripts/selftest.sh`
Expected: every check prints PASS.

Run: `xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test 2>&1 | tail -5`
Expected: `** TEST SUCCEEDED **`. If XCUITest cannot activate the app (locked screen), note it and rely on `selftest.sh`.

By hand, with `open build/Build/Products/Debug/Breezy.app`:
1. First launch shows the Boards window, empty. ⌘N opens "New Board"; double-click empty space and type a card.
2. In Boards, click the selected row's title and rename it: the board window's title follows.
3. Quit with the board window open and relaunch: the window comes back with its card, at the same scroll and zoom.
4. Delete the board from Boards (−, Delete): its window closes.
5. `ls -l ~/Library/Application\ Support/Breezy/space.json` shows `-rw-------`.

- [ ] **Step 10: Commit**

```bash
git add -A Breezy BreezyUITests project.yml scripts/make-icons.swift
git commit --message "Keep the Mac's boards in a store instead of files" --message "A Boards window lists them; each board opens in a window of its own, restored after a relaunch." --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 18: Syncing from the Mac app

**Files:**
- Create: `Breezy/Library/SyncMenu.swift`
- Modify: `Breezy/Library/Library.swift`, `Breezy/App/AppDelegate.swift`, `Breezy/App/MainMenu.swift`, `Breezy/Library/BoardsWindowController.swift`

**Interfaces:**
- Consumes: `SyncEngine`, `Invite`, `Store.startSyncing/join`
- Produces: `Library.engine`, `Library.syncNow()`, `Library.statusLines`, `AppDelegate.startSyncing(_:)`, `joinSpace(_:)`, `shareInvite(_:)`, `SyncMenu.shared`, `.syncStatusChanged`

- [ ] **Step 1: Give the library an engine and its timings**

In `Library.swift`, add `static let syncStatusChanged = Notification.Name("BreezySyncStatusChanged")` to the `Notification.Name` extension. Add the properties `let engine: SyncEngine` and `private var timer: Timer?`. In `init`, after `store = …`:

```swift
    engine = SyncEngine(store: store)
```

and at the end of `init`:

```swift
    engine.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    engine.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.syncNow() }
    }
```

Add:

```swift
  var statusLines: [String] { engine.status.lines() }

  func syncNow() { Task { await engine.sync() } }

  /// Every 5 s while a board shows.
  private func poll() {
    if documents.contains(where: { $0.windowController?.window?.occlusionState.contains(.visible) == true }) { syncNow() }
  }
```

In `changed(_:remote:)`, before posting the notification:

```swift
    if !remote { engine.changed() }
```

In `open(_:display:)`, before `return`:

```swift
    syncNow()
```

- [ ] **Step 2: Write `Breezy/Library/SyncMenu.swift`**

```swift
import AppKit

/// Puts the sync status above the Breezy menu's sync items each time the menu opens.
final class SyncMenu: NSObject, NSMenuDelegate {
  static let shared = SyncMenu()
  static let tag = 7_001

  func menuNeedsUpdate(_ menu: NSMenu) {
    for i in menu.items where i.tag == Self.tag { menu.removeItem(i) }
    guard let at = menu.items.firstIndex(where: { $0.action == #selector(AppDelegate.startSyncing(_:)) }) else { return }
    for (n, line) in MainActor.assumeIsolated({ Library.shared.statusLines }).enumerated() {
      let i = NSMenuItem(title: line, action: nil, keyEquivalent: "")
      i.tag = Self.tag
      menu.insertItem(i, at: at + n)
    }
  }
}
```

- [ ] **Step 3: Add the Breezy menu's items**

In `MainMenu.make()`, replace `main.addItem(submenu("Breezy", [ … ]))` with:

```swift
    let app = submenu("Breezy", [
      item("About Breezy", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Start Syncing…", #selector(AppDelegate.startSyncing(_:))),
      item("Join Space…", #selector(AppDelegate.joinSpace(_:))),
      item("Share Invite", #selector(AppDelegate.shareInvite(_:))),
      .separator(),
      item("Hide Breezy", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Breezy", #selector(NSApplication.terminate(_:)), "q"),
    ])
    app.submenu?.delegate = SyncMenu.shared
    main.addItem(app)
```

- [ ] **Step 4: Add the actions to `AppDelegate`**

Make the class conform to `NSMenuItemValidation` and add:

```swift
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    let syncing = Library.shared.store.state.invite != nil
    switch item.action {
    case #selector(startSyncing(_:)): return !syncing
    case #selector(shareInvite(_:)): return syncing
    default: return true
    }
  }

  private func field(_ placeholder: String) -> NSTextField {
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    f.placeholderString = placeholder
    return f
  }

  private func tell(_ message: String, _ info: String) {
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = info
    alert.runModal()
  }

  @objc func startSyncing(_ sender: Any?) {
    let input = field("https://example.com/breezy/sync.php")
    let alert = NSAlert()
    alert.messageText = "Start Syncing"
    alert.informativeText = "The address of your Breezy server. Boards are encrypted on this Mac; the server can’t read them."
    alert.accessoryView = input
    alert.addButton(withTitle: "Start Syncing")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let server = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard Invite.validServer(server) else { return tell("That isn’t a server address", "Use an https:// address ending in sync.php.") }
    Library.shared.store.startSyncing(server: server)
    Library.shared.engine.reset()
    Library.shared.syncNow()
  }

  @objc func joinSpace(_ sender: Any?) {
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
    let lib = Library.shared!
    let n = lib.store.boards.count
    if n > 0 {
      let sure = NSAlert()
      sure.messageText = "Replace the boards on this Mac?"
      sure.informativeText = "Joining shows the space’s boards instead of the \(n == 1 ? "board" : "\(n) boards") here, which are deleted from this Mac."
      sure.addButton(withTitle: "Join").hasDestructiveAction = true
      sure.addButton(withTitle: "Cancel")
      guard sure.runModal() == .alertFirstButtonReturn else { return }
    }
    lib.documents.forEach { $0.close() }
    lib.store.join(invite)
    lib.engine.reset()
    lib.syncNow()
    BoardsWindowController.shared.showWindow(nil)
  }

  @objc func shareInvite(_ sender: Any?) {
    guard let link = Library.shared.store.state.invite?.link else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(link, forType: .string)
    tell("Invite link copied", "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.")
  }
```

In `applicationDidFinishLaunching`, after the Boards window line:

```swift
    Library.shared.syncNow()
```

- [ ] **Step 5: Show the status in the Boards window**

In `BoardsWindowController.init`, after the `.boardsChanged` observer:

```swift
    NotificationCenter.default.addObserver(forName: .syncStatusChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateStatus() }
    }
```

At the end of `reload()`, call `updateStatus()`, and add:

```swift
  func updateStatus() { status.stringValue = Library.shared.statusLines.joined(separator: " · ") }
```

- [ ] **Step 6: Build and try it against the dev server**

Run: `xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build 2>&1 | tail -3`
Expected: `** BUILD SUCCEEDED **`.

Run in the background: `server/dev.sh`, and `npx --yes live-server@1.2.2 web --port=58565 --no-browser`. Then:
1. Mac: Breezy → Start Syncing… with `http://127.0.0.1:58566/sync.php`. The Boards window shows "Synced just now", and the menu shows it above Start Syncing, which is now dimmed.
2. Mac: Share Invite. In Chrome at `http://localhost:58565/`: Join Space, paste. The Mac's boards appear.
3. Move a card on the Mac: it moves in Chrome within 6 s. Move one in Chrome: it springs into place on the Mac within 6 s while the board window is visible.
4. Type into a card on the Mac while Chrome changes another card: the Mac's text stays, and Chrome's change arrives when the edit ends.
5. Rename a board in Chrome: the Mac's window title and Boards window follow.
6. Stop `server/dev.sh`, edit on the Mac: within 10 s Boards shows "Can’t reach server". Restart: "Synced just now".

Run: `scripts/selftest.sh`
Expected: every check prints PASS.

- [ ] **Step 7: Commit**

```bash
git add Breezy
git commit --message "Start, join and share a space from the Mac app" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```

---

### Task 19: Documentation and a last check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

- Opening paragraph: "A native Mac app; each board is a `.breezy` file." becomes "A native Mac app and a web app, which can share boards through a small server."
- Build: drop the sentence about Versions. Add: "Boards live in `~/Library/Application Support/Breezy/space.json` and reopen where they were left after a relaunch."
- Use table: add rows `| Boards | ⇧⌘B lists them; ⌘N makes one; click a selected title to rename it, ⌫ to delete |` and `| Sync | Breezy → Start Syncing…, Join Space…, Share Invite |`.
- Touch prototype section: replace "It keeps nothing: reloading starts from the sample board, `?stress` loads 500 cards." with "It keeps its boards in the browser and opens on a list of them; `?stress` loads 500 cards into a board it does not keep."
- Add a section:

```markdown
## Sync

Two people share one space of boards across their devices. Everything is encrypted on the devices; the server stores only what it cannot read. See `docs/superpowers/specs/2026-10-08-breezy-sync-design.md`.

The server is `server/sync.php` on PHP 8 with MySQL: upload `sync.php` and `.htaccess`, run `schema.sql`, and copy `config.example.php` to `config.php` with the database's details. It must be served over HTTPS. Then Start Syncing on one device with the address of `sync.php`, Share Invite, and Join Space on the others with the link.

```bash
server/test.sh   # sync.php against SQLite, then the Mac's HTTP client against it; needs php (brew install php)
server/dev.sh    # serves http://127.0.0.1:58566/sync.php from build/ for trying sync on this Mac
```
```

- [ ] **Step 2: Run everything**

Run: `swift test --package-path BreezyKit && node --test web/test/*.test.js && server/test.sh && scripts/selftest.sh`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit --message "Describe sync and the boards that replace files" --message "Claude-Session: https://claude.ai/code/session_01JW5V8WUaTofPN1yUpyYEgi"
```
