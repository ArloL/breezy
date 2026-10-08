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
