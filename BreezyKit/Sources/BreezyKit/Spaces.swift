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
      let target = file(for: state.space)
      if try target.load() == nil { try target.saveNow(state) }
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
      let order = a.name.localizedStandardCompare(b.name)
      return order == .orderedSame ? a.space! < b.space! : order == .orderedAscending
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
