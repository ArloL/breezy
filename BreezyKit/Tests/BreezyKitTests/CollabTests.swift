// Mirrored in web/test/collab.test.js: the same cases, so that both apps' glue behaves alike.
import Foundation
import Testing
@testable import BreezyKit

private func id(_ n: UInt8) -> String { Base64URL.encode(Data(repeating: n, count: 16)) }
private let C1 = id(0xc1), C2 = id(0xc2), C3 = id(0xc3)

/// A device in a space with boards `b1` (cards C1, C2) and `b2` (C3), its Collab, and another device watching `b1`.
@MainActor private final class Setup {
  let clock = Clock()
  let relay: FakeRelay
  let store = Store()
  let transport: FakeTransport
  let engine: SyncEngine
  let live: Live
  let other: Live
  let group: Spaces.Group
  let collab: Collab
  let b1: String
  let b2: String
  /// What `open` made, kept as the apps' documents keep them.
  var bindings: [BoardBinding] = []

  init() async {
    relay = FakeRelay(clock: clock)
    _ = store.startSyncing(server: testServer)
    b1 = store.createBoard(title: "One", contents: board([card(C1, 0, 0), card(C2, 480, 0)]))
    b2 = store.createBoard(title: "Two", contents: board([card(C3, 0, 0)]))
    let t = FakeTransport(FakeServer())
    transport = t
    let clock = clock
    engine = SyncEngine(store: store, now: { clock.now }, transport: { _, _ in t })
    await engine.sync()
    let keys = try! SpaceKeys(state: store.state), space = store.state.space!, relay = relay
    let live = { (name: String) in
      Live(relay: "wss://relay.example/", space: space, keys: keys, me: Person(device: newID(), name: name),
           socket: { relay.connect($0) }, now: { clock.now }, uptime: { clock.now.timeIntervalSince1970 * 1000 },
           schedule: { clock.schedule($0, $1) })
    }
    let mine = live("Ana")
    self.live = mine
    other = live("Bo")
    engine.onPushing = { mine.pushing() }
    engine.onPushed = { mine.sendPushed($0) }
    for l in [mine, other] {
      l.connect()
      relay.run()
    }
    mine.setPresence(board: b1, selection: [])
    other.setPresence(board: b1, selection: [])
    relay.run()
    group = Spaces.Group(store: store, engine: engine, file: StoreFile(url: FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).json")))
    group.live = mine
    collab = Collab(group: group, holds: GestureHolds())
  }

  /// Board `b` open, as the apps open it.
  func open(_ b: String) -> (model: BoardModel, session: Collab.Session) {
    let model = BoardModel(board: store.board(b))
    let binding = BoardBinding(id: b, model: model, store: store)
    bindings.append(binding)
    return (model, collab.open(b, model: model, binding: binding))
  }

  var pushes: Int { transport.log.filter { $0 == "push" }.count }

  /// Lets syncs, finishes, gesture ends and the relay run.
  func settle() async {
    for _ in 0..<200 { await Task.yield() }
    relay.run()
  }

  func color(_ b: String, _ c: String) -> Int? { store.board(b).cards.first { $0.id == c }?.color }
  func x(_ b: String, _ c: String) -> Double? { store.board(b).cards.first { $0.id == c }?.x }
}

private func move(_ c: String, _ x: Double) -> (inout Board) -> Void {
  { b in if let i = b.cards.firstIndex(where: { $0.id == c }) { b.cards[i].x = x } }
}

@MainActor @Test func aRecolourOutsideAGestureFlushesPushesAtOnceAndSendsOneKeyframeWhenThePushGoesNowAndNoneBehindABackOff() async {
  let d = await Setup()
  let (model, _) = d.open(d.b1)
  let before = d.pushes
  model.perform("Color") { $0.setColor([C1], 3) }
  #expect(d.color(d.b1, C1) == 3)
  await d.settle()
  #expect(d.pushes == before + 1)
  #expect(d.other.overlay(on: d.b1) == [C1: ["color": .number(3)]])
  d.transport.online = false
  await d.engine.sync()
  d.transport.online = true
  model.perform("Color") { $0.setColor([C2], 4) }
  #expect(d.color(d.b1, C2) == 4)
  await d.settle()
  #expect(d.pushes == before + 1)
  #expect(d.other.overlay(on: d.b1)[C2] == nil)
}

@MainActor @Test func aPressHoldsMovesSendLiveBodiesNothingIsPushedUntilTheEndTheEndFlushesPushesThenReleases() async {
  let d = await Setup()
  let (model, session) = d.open(d.b1)
  var held: [Int] = []
  d.transport.beforePush = { held.append(d.live.mine.count) }
  let before = d.pushes
  model.begin()
  session.hold([C1])
  d.relay.run()
  #expect(d.other.taken == [C1])
  for x in [24.0, 48, 72] {
    d.clock.advance(0.03)
    model.update(move(C1, x))
    d.relay.run()
  }
  d.clock.advance(0.2)
  #expect(d.other.overlay(on: d.b1)[C1] == ["pos": .array([.number(72), .number(0)])])
  #expect(d.pushes == before)
  model.end("Move")
  await d.settle()
  #expect(d.x(d.b1, C1) == 72)
  #expect(d.pushes == before + 1)
  #expect(held == [1])
  #expect(d.live.mine.isEmpty)
  #expect(d.other.taken.isEmpty)
}

@MainActor @Test func aGesturesEndWhileAnotherStartedOnTheSameSpaceDoesNotRelease() async {
  let d = await Setup()
  let one = d.open(d.b1), two = d.open(d.b2)
  one.model.begin()
  one.session.hold([C1])
  one.model.update(move(C1, 24))
  two.model.begin()
  two.session.hold([C3])
  one.model.end("Move")
  await d.settle()
  #expect(d.live.mine == [C1, C3])
  two.model.end("Move")
  await d.settle()
  #expect(d.live.mine.isEmpty)
}

@MainActor @Test func tickReleasesHoldsThatNoGestureOrFinishExplainsOnTheSecondIdleTick() async {
  let d = await Setup()
  let (model, session) = d.open(d.b1)
  model.begin()
  session.hold([C1])
  for _ in 0..<3 { d.collab.tick() }
  #expect(d.live.mine.count == 1)
  model.cancel()
  await d.settle()
  d.live.hold([C2])
  d.collab.tick()
  #expect(d.live.mine.count == 1)
  d.collab.tick()
  #expect(d.live.mine.isEmpty)
}

@MainActor @Test func holdBackIsTrueOnlyDuringAGestureWithTheRelayConnectedAndSomethingHeld() async {
  let d = await Setup()
  let (model, session) = d.open(d.b1)
  #expect(d.engine.holdBack?() == false)
  d.live.hold([C2])
  #expect(d.engine.holdBack?() == false)
  d.live.release()
  model.begin()
  #expect(d.engine.holdBack?() == false)
  session.hold([C1])
  #expect(d.engine.holdBack?() == true)
  d.relay.kick(d.relay.sockets[0], code: 1006)
  d.relay.run()
  #expect(d.engine.holdBack?() == false)
  model.end("Move")
  #expect(d.engine.holdBack?() == false)
}

@MainActor @Test func anEditEndingAGestureThatHeldNothingCountsAsAnEditOutsideAGesture() async {
  let d = await Setup()
  let (model, _) = d.open(d.b1)
  let before = d.pushes
  model.begin()
  model.update { $0.setColor([C1], 5) }
  model.end("Color")
  await d.settle()
  #expect(d.color(d.b1, C1) == 5)
  #expect(d.pushes == before + 1)
  #expect(d.other.overlay(on: d.b1) == [C1: ["color": .number(5)]])
}
