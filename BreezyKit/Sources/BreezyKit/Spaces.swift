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
    /// The space's live layer, once its server names a relay.
    public internal(set) var live: Live?

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
  /// This device as others in its spaces see it.
  public var me: Person { didSet { for g in spaces { g.live?.me = me } } }
  /// After a group's live layer appears, goes, or hears something.
  public var onLive: ((Group) -> Void)?
  /// The relay refused holds the group's live layer asked for.
  public var onRefused: ((Group, Set<String>) -> Void)?
  private let transport: ((SpaceState, SpaceKeys) -> Transport?)?
  private let socket: (@MainActor (URL) -> LiveSocket)?
  private let peerTransport: (@MainActor () -> PeerTransport)?

  /// The groups in `directory`/Spaces, after moving a store from before spaces, `directory`/space.json, among them.
  public init(
    directory: URL, me: Person = Person(device: newID(), name: ""), transport: ((SpaceState, SpaceKeys) -> Transport?)? = nil,
    socket: (@MainActor (URL) -> LiveSocket)? = nil, peerTransport: (@MainActor () -> PeerTransport)? = nil
  ) throws {
    self.directory = directory.appendingPathComponent("Spaces")
    self.me = me
    self.transport = transport
    self.socket = socket
    self.peerTransport = peerTransport
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
    engine.onRelay = { [weak self, weak g] relay in
      guard let self, let g else { return }
      setRelay(relay, for: g)
    }
    engine.onPushed = { [weak g] in g?.live?.sendPushed($0) }
    engine.onPulled = { [weak g] in g?.live?.noteCursor($0) }
    file.onError = { [weak self] in self?.onError?($0) }
    return g
  }

  /// Replaces the group's live layer with one on `relay`, or none.
  private func setRelay(_ relay: String?, for g: Group) {
    guard relay != g.live?.relay else { return }
    g.live?.close()
    g.live = nil
    if let relay, let space = g.space, let keys = try? SpaceKeys(state: g.store.state) {
      let transport = peerTransport?()
      let live = socket.map { Live(relay: relay, space: space, keys: keys, me: me, socket: $0, transport: transport) }
        ?? Live(relay: relay, space: space, keys: keys, me: me, transport: transport)
      live.onPushed = { [weak g] version, pushed in
        // a repeat of what this device has already
        guard let g, pushed != nil || version > g.store.state.cursor else { return }
        Task {
          if let pushed, await g.engine.receivePushed(pushed) { return }
          await g.engine.sync()
        }
      }
      live.onChange = { [weak self, weak g] in
        guard let self, let g else { return }
        onLive?(g)
      }
      live.onRefused = { [weak self, weak g] ids in
        guard let self, let g else { return }
        onRefused?(g, ids)
      }
      live.onWelcome = { [weak g] in g?.engine.retryNow() }
      // a refused token is the server's to report: its 401 shows "Not in this space any more"
      live.onUnauthorized = { [weak g] in
        guard let g else { return }
        Task { await g.engine.sync() }
      }
      g.live = live
    }
    onLive?(g)
  }

  /// On this device first, then the spaces by name, as Finder orders them but with names alike but for case tied, then
  /// by space id.
  public var groups: [Group] {
    [local] + spaces.sorted { a, b in
      let fold = { (g: Group) in g.name.folding(options: [.caseInsensitive, .widthInsensitive], locale: .current) }
      let order = fold(a).compare(fold(b), options: .numeric, locale: .current)
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
    group.live?.close()
    group.live = nil
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

  /// A cycle for every space, each on its own. When `polling`, a space whose live layer is connected waits 30 s
  /// between cycles: its relay announces what others push.
  public func syncAll(polling: Bool = false, now: Date = Date()) {
    for g in spaces {
      if polling, g.live?.connected == true, let last = g.engine.lastSynced, now.timeIntervalSince(last) < 30 { continue }
      Task { await g.engine.sync() }
    }
  }

  /// The network may have changed, as when the app becomes active, or did (`changed`), as when it comes back or the Mac
  /// wakes: every space syncs now and checks its relay.
  public func retryAll(changed: Bool = false) {
    for g in spaces {
      g.engine.retryNow()
      g.live?.check(changed: changed)
    }
  }

  /// Writes every group's file before returning.
  public func saveNow() {
    for g in groups { g.file.save(g.store.state, wait: true) }
  }
}
