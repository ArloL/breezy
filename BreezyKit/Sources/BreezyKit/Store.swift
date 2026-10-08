import Foundation

public struct StoredRecord: Codable, Equatable, Sendable {
  /// As last pulled or pushed; nil until the server has it.
  public var base: Record?
  public var version: Int
  /// As this device has it.
  public var current: Record
  /// While a resync runs, the version from before it, to tell a backup newer than this device from an older one.
  public var prior: Int?
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
  /// The server's name for this copy of the space; a database restored from a backup gets a new one.
  public var epoch: String?
  /// Pulling everything again after the epoch changed.
  public var resync = false

  public init() {}

  public var invite: Invite? {
    guard let server, let space, let secret else { return nil }
    return Invite(server: server, space: space, secret: secret)
  }
}

extension SpaceState {
  /// Files from before `epoch` and `resync` read as not resyncing.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    server = try c.decodeIfPresent(String.self, forKey: .server)
    space = try c.decodeIfPresent(String.self, forKey: .space)
    secret = try c.decodeIfPresent(String.self, forKey: .secret)
    cursor = try c.decode(Int.self, forKey: .cursor)
    records = try c.decode([String: StoredRecord].self, forKey: .records)
    held = try c.decode([String: Held].self, forKey: .held)
    unreadable = try c.decode(Int.self, forKey: .unreadable)
    epoch = try c.decodeIfPresent(String.self, forKey: .epoch)
    resync = try c.decodeIfPresent(Bool.self, forKey: .resync) ?? false
  }
}

public struct Incoming: Equatable, Sendable {
  public var id: String
  public var version: Int
  public var record: Record
  /// As a restored backup has it; see `Pulled.stale`.
  public var stale = false
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

  /// Local edits. A deleted record stays deleted; partial fields for an unknown record, and new
  /// records on a deleted board, are dropped.
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
          guard f["kind"] != nil, !(f["board"]?.string.flatMap { state.records[$0]?.current.deleted } ?? false) else { continue }
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

  /// Records from the server, merged three ways into those with local changes. While resyncing, a
  /// stale record this device has seen at least as new becomes its base, so that what the device has
  /// since is pushed.
  public func merge(_ items: [Incoming]) {
    guard !items.isEmpty else { return }
    var boards = Set<String>()
    for item in items {
      let old = state.records[item.id]
      if let old, state.resync, item.stale, item.version <= old.prior ?? 0 {
        state.records[item.id] = StoredRecord(base: item.record, version: item.version, current: old.current)
        continue
      }
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

  /// Takes the server's epoch when none is stored; when it differs from the stored one, as after a
  /// restore from a backup or the loss of the space, starts pulling everything again, as `merge`
  /// and `resynced` describe, and returns true.
  public func note(epoch: String?) -> Bool {
    guard epoch != state.epoch else { return false }
    defer { onDirty?() }
    guard state.epoch != nil else {
      state.epoch = epoch
      return false
    }
    state.epoch = epoch
    state.cursor = 0
    state.resync = true
    state.unreadable = 0
    for (id, r) in state.records {
      state.records[id]!.prior = r.prior ?? r.version
      state.records[id]!.version = 0
    }
    return true
  }

  /// The resync's pull is done; records the server lacks wait to be pushed as new.
  public func resynced() {
    guard state.resync else { return }
    state.resync = false
    for (id, s) in state.records {
      state.records[id]!.prior = nil
      if s.version == 0 { state.records[id]!.base = nil }
    }
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
    state.epoch = nil
    state.resync = false
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
