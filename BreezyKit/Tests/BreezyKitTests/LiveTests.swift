import Foundation
import Testing
@testable import BreezyKit

private let space = "QEFCQ0RFRkdISUpLTE1OTw"

private func keys() -> SpaceKeys {
  SpaceKeys(space: Base64URL.decode(space)!, secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
}

private func id(_ n: UInt8) -> String { Base64URL.encode(Data(repeating: n, count: 16)) }
private let B1 = id(0xb1), B2 = id(0xb2), C1 = id(0xc1), C2 = id(0xc2), C3 = id(0xc3)
private func pos(_ x: Double, _ y: Double) -> JSONValue { .array([.number(x), .number(y)]) }
private let moved: [String: LiveFields] = [C1: ["pos": pos(48, 0)]]

/// A body a device sent through the relay, opened, a compact one decoded.
private struct Sent {
  var to: Int?
  var size: Int
  var body: [String: JSONValue]
}

/// What connection `from` sent through the relay.
@MainActor private func sentBy(_ relay: FakeRelay, _ from: String?) -> [Sent] {
  let decoder = LiveDecoder()
  return relay.frames.compactMap { f in
    guard f.from == from, let bytes = f.bytes, let (to, body) = FakeRelay.parse(bytes), let plain = try? keys().openLive(body) else { return nil }
    let b = Compact.isCompact(plain) ? decoder.decode(plain) : try? JSONDecoder().decode([String: JSONValue].self, from: plain)
    return Sent(to: to, size: bytes.count, body: b ?? [:])
  }
}

private func fast(_ sent: [Sent]) -> [Sent] { sent.filter { ["cursor", "live"].contains($0.body["t"]?.string) } }
@MainActor private func alives(_ relay: FakeRelay, _ from: String?) -> Int { relay.frames.filter { $0.from == from && $0.text == #"{"t":"alive"}"# }.count }

@MainActor private func live(_ relay: FakeRelay, _ clock: Clock, name: String = "Ana", device: String = newID(), keys k: SpaceKeys = keys(), transport: PeerTransport? = nil) -> Live {
  Live(relay: "wss://relay.example/", space: space, keys: k, me: Person(device: device, name: name),
       socket: { relay.connect($0) }, now: { clock.now },
       uptime: { clock.now.timeIntervalSince1970 * 1000 }, schedule: { clock.schedule($0, $1) }, transport: transport)
}

private func colour(_ device: String) -> UInt32 { Person(device: device, name: "").colour }

/// Two connected devices, both showing board B1; through a relay from before the lean sync design when `old`.
@MainActor private func two(old: Bool = false) -> (FakeRelay, Clock, Live, Live) {
  let clock = Clock(), relay = FakeRelay(clock: clock, old: old)
  let a = live(relay, clock, name: "Ana Lima"), b = live(relay, clock, name: "Bo")
  a.connect()
  relay.run()
  b.connect()
  relay.run()
  a.setPresence(board: B1, selection: [])
  b.setPresence(board: B1, selection: [])
  relay.run()
  return (relay, clock, a, b)
}

/// `body` from `from` through the relay, as any client may send it.
@MainActor private func inject(_ relay: FakeRelay, from: Live, _ body: [String: JSONValue], to: String? = nil) throws {
  let sealed = try keys().sealLive(JSONEncoder().encode(JSONValue.object(body)))
  var f: [String: JSONValue] = ["body": .string(Base64URL.encode(sealed))]
  if let to { f["to"] = .string(to) }
  relay.received(relay.sockets.first { $0.id == from.id }!, String(decoding: try JSONEncoder().encode(JSONValue.object(f)), as: UTF8.self))
  relay.run()
}

@MainActor @Test func peopleSeeEachOtherAndWhatTheyHaveSelected() {
  let (relay, _, a, b) = two()
  #expect(a.connected && b.connected)
  a.setPresence(board: B1, selection: [C1])
  relay.run()
  #expect(b.people(on: B1).map(\.name) == ["Ana Lima"])
  #expect(b.people(on: B1).first?.initials == "AL")
  #expect(b.people(on: B1).first?.colour == colour(a.me.device))
  #expect(b.selections(on: B1)[C1]?.name == "Ana Lima")
  #expect(a.people(on: B1).map(\.name) == ["Bo"])
  #expect(a.people(on: B2).isEmpty)
  #expect(Person(device: newID(), name: " ").initials == "?")
  #expect(Person.palette.contains(colour(newID())))
}

@MainActor @Test func cursorsGoAtMostTwentyTimesASecond() {
  let (relay, clock, a, b) = two()
  let sent = { fast(sentBy(relay, a.id)).count }
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  #expect(sent() == 1)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [1])
  a.sendCursor(board: B1, x: 2, y: 2)
  a.sendCursor(board: B1, x: 3, y: 3)
  relay.run()
  #expect(sent() == 1)
  clock.advance(0.05)
  relay.run()
  #expect(sent() == 2)
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [3])
  a.sendCursor(board: B1, x: nil, y: nil)
  clock.advance(0.05)
  relay.run()
  #expect(b.cursors(on: B1).isEmpty)
}

@MainActor @Test func aStillCursorFadesAfterAMinute() {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  for _ in 0..<2 {
    clock.advance(29)
    a.tick()
    relay.run()
  }
  b.tick()
  #expect(b.cursors(on: B1).count == 1)
  clock.advance(3)
  b.tick()
  #expect(b.cursors(on: B1).isEmpty)
  #expect(b.people(on: B1).count == 1)
}

@MainActor @Test func holdsAreAllOrNoneAndShowWhoHolds() {
  let (relay, _, a, b) = two()
  var refused: Set<String> = []
  b.onRefused = { refused = $0 }
  a.hold(["x", "y"])
  relay.run()
  #expect(b.taken == ["x", "y"])
  #expect(b.holder(of: "x")?.name == "Ana Lima")
  #expect(a.taken.isEmpty)
  b.hold(["y", "z"])
  relay.run()
  #expect(refused == ["y"])
  b.release()
  a.release()
  relay.run()
  #expect(b.taken.isEmpty && a.mine.isEmpty)
}

@MainActor @Test func liveEditsShowAsAnOverlay() {
  let (relay, _, a, b) = two()
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: Caret(id: C1, back: false, at: 3))
  relay.run()
  #expect(b.overlay(on: B1) == moved)
  #expect(b.overlay(on: B2).isEmpty)
  #expect(b.carets(on: B1).map { $0.caret } == [Caret(id: C1, back: false, at: 3)])
}

@MainActor @Test func theOverlayStaysUntilThePullReachesThePushedVersion() {
  let (relay, _, a, b) = two()
  var pushes: [Int] = []
  b.onPushed = { v, _ in pushes.append(v) }
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  a.sendPushed(Pushed(version: 7, epoch: nil, records: []))
  a.release()
  relay.run()
  #expect(pushes == [7])
  #expect(b.overlay(on: B1) == moved)
  b.noteCursor(6)
  #expect(b.overlay(on: B1) == moved)
  b.noteCursor(7)
  #expect(b.overlay(on: B1).isEmpty)
}

@MainActor @Test func aHoldThatEndsWithoutAPushDropsTheOverlay() {
  let (relay, _, a, b) = two()
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: Caret(id: C1, back: false, at: 0))
  relay.run()
  relay.lapse(relay.sockets[0])
  relay.run()
  #expect(b.taken.isEmpty)
  #expect(b.overlay(on: B1).isEmpty)
  #expect(b.carets(on: B1).isEmpty)
}

@MainActor @Test func anotherConnectionOfTheSameDeviceStillHolds() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  let device = newID()
  let a = live(relay, clock, device: device), a2 = live(relay, clock, device: device)
  a.connect()
  a2.connect()
  relay.run()
  a.setPresence(board: B1, selection: [])
  a.hold([C1])
  relay.run()
  #expect(a2.taken == [C1])
  #expect(a2.people(on: B1).isEmpty)
}

@MainActor @Test func aPeerThatLeavesOrFallsSilentIsGone() {
  let (relay, clock, a, b) = two()
  a.hold([C1])
  relay.run()
  a.close()
  relay.run()
  #expect(b.people(on: B1).isEmpty && b.taken.isEmpty)
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: B1, selection: [])
  relay.run()
  #expect(b.people(on: B1).map(\.name) == ["Cy"])
  clock.advance(31)
  b.tick()
  #expect(b.people(on: B1).isEmpty)
}

@MainActor @Test func presenceRepeatsAndAHolderTellsTheRelayItIsAlive() {
  let (relay, clock, a, _) = two()
  let presences = { sentBy(relay, a.id).filter { $0.body["t"]?.string == "presence" }.count }
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  let start = presences()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(alives(relay, a.id) == 1)
  clock.advance(10)
  a.tick()
  relay.run()
  #expect(alives(relay, a.id) == 2)
  #expect(presences() == start + 1)
  a.release()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(alives(relay, a.id) == 2)
}

@MainActor @Test func aReconnectAsksForItsHoldsAgain() {
  let (relay, clock, a, b) = two()
  var refused: Set<String> = []
  a.onRefused = { refused = $0 }
  a.hold([C1])
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  #expect(!a.connected && b.taken.isEmpty)
  #expect(a.mine == [C1])
  b.hold([C1])
  relay.run()
  clock.advance(1)
  relay.run()
  #expect(a.connected)
  #expect(refused == [C1])
}

@MainActor @Test func reconnectsBackOffAndStopForAWrongToken() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  let a = live(relay, clock)
  a.connect()
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  clock.advance(1)
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  clock.advance(1.9)
  relay.run()
  #expect(relay.sockets.isEmpty)
  clock.advance(0.1)
  relay.run()
  #expect(a.connected)

  let wrong = FakeRelay(clock: clock)
  wrong.token = "someone else's"
  var unauthorized = false
  let b = live(wrong, clock)
  b.onUnauthorized = { unauthorized = true }
  b.connect()
  wrong.run()
  clock.advance(60)
  wrong.run()
  #expect(unauthorized && !b.connected && wrong.sockets.isEmpty)
}

@MainActor @Test func bodiesSealedForAnotherSpaceAreDropped() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  // the same secret, so the same token and key, but another space: its bodies do not open here
  let other = SpaceKeys(space: randomBytes(16), secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
  let stranger = live(relay, clock, keys: other)
  let b = live(relay, clock)
  stranger.connect()
  b.connect()
  relay.run()
  stranger.setPresence(board: B1, selection: [])
  relay.run()
  #expect(stranger.connected && b.connected)
  #expect(b.people(on: B1).isEmpty)
}

@MainActor @Test func aHolderWithNothingLiveYetStillKeepsItsHold() {
  let (relay, clock, a, _) = two()
  a.hold([C1])
  relay.run()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(alives(relay, a.id) == 1)
  a.release()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(alives(relay, a.id) == 1)
}

@MainActor @Test func theRelayGetsATokenMadeForIt() {
  let (relay, _, _, _) = two()
  #expect(relay.token == Base64URL.encode(keys().relayToken))
  #expect(relay.sockets.allSatisfy { $0.v == 2 })
}

@MainActor @Test func connectingAgainWaitsForTheBackOff() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  let a = live(relay, clock)
  a.connect()
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  for _ in 0..<3 {
    a.connect()
    relay.run()
  }
  clock.advance(0.9)
  a.connect()
  relay.run()
  #expect(relay.opened == 1)
  clock.advance(0.1)
  relay.run()
  #expect(relay.opened == 2 && a.connected)
}

@MainActor @Test func aRefusedTokenKeepsTheLayerClosed() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  relay.token = "someone else's"
  let a = live(relay, clock)
  a.connect()
  relay.run()
  for _ in 0..<3 {
    a.close()
    a.connect()
    clock.advance(60)
    relay.run()
  }
  #expect(relay.opened == 1 && !a.connected)
}

@MainActor @Test func aSocketThatStopsAnsweringIsClosedAndOpenedAgain() {
  let (relay, clock, a, _) = two()
  let first = relay.sockets[0]
  clock.advance(20)
  a.tick()
  relay.run()
  #expect(relay.pings == 1)
  clock.advance(10)
  a.tick()
  #expect(a.connected)
  clock.advance(10)
  a.tick()
  relay.run()
  #expect(relay.pings == 2)
  first.halfOpen = true
  clock.advance(20)
  a.tick()
  relay.run()
  clock.advance(9)
  a.tick()
  #expect(a.connected)
  clock.advance(1)
  a.tick()
  #expect(!a.connected)
  relay.run()
  #expect(!relay.sockets.contains { $0 === first })
  clock.advance(1)
  relay.run()
  #expect(a.connected && relay.opened == 3)
}

@MainActor @Test func aClosedLayerHoldsNothing() {
  let (relay, clock, a, b) = two()
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  a.close()
  relay.run()
  #expect(a.mine.isEmpty)
  a.connect()
  relay.run()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(a.connected && b.taken.isEmpty && b.overlay(on: B1).isEmpty)
}

@MainActor @Test func whatThisDeviceHoldsIsNotOverlaid() {
  let (relay, _, a, b) = two()
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  a.sendPushed(Pushed(version: 7, epoch: nil, records: []))
  a.release()
  relay.run()
  #expect(b.overlay(on: B1) == moved)
  b.hold([C1])
  relay.run()
  #expect(b.overlay(on: B1).isEmpty)
}

@MainActor @Test func cursorsAndLiveFieldsGoOnlyWhenSomeoneIsThere() {
  let clock = Clock(), relay = FakeRelay(clock: clock)
  let a = live(relay, clock)
  a.connect()
  relay.run()
  a.setPresence(board: B1, selection: [])
  relay.run()
  a.sendCursor(board: B1, x: 1, y: 1)
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  clock.advance(1)
  relay.run()
  #expect(fast(sentBy(relay, a.id)).isEmpty)
  let b = live(relay, clock, name: "Bo")
  b.connect()
  relay.run()
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [1])
  b.setPresence(board: B1, selection: [])
  relay.run()
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  #expect(b.overlay(on: B1) == moved)
}

@MainActor @Test func cursorsAndLiveEditsCarryTheSendersTimeAndASequenceNumber() {
  let (relay, clock, a, _) = two()
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(0.05)
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  let b = fast(sentBy(relay, a.id)).map(\.body)
  #expect(b.map { $0["t"]?.string } == ["cursor", "live"])
  #expect(b.map { $0["seq"]?.number } == [1, 2])
  #expect(abs(b[1]["at"]!.number! - b[0]["at"]!.number! - 50) < 0.001)
}

@MainActor @Test func cursorsPlayBackSmoothlyBetweenUpdates() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10, 20] {
    a.sendCursor(board: B1, x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  // the buffer is one 50 ms interval: 50 ms after the last arrived, playback is halfway between the last two
  clock.advance(-0.025)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [15])
  #expect(b.animating(on: B1))
  #expect(!b.animating(on: B2))
  clock.advance(0.1)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [20])
  #expect(!b.animating(on: B1))
}

@MainActor @Test func aCursorOnAnotherBoardJumpsThere() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10] {
    a.sendCursor(board: B1, x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  a.sendCursor(board: B2, x: 500, y: 500)
  relay.run()
  #expect(b.cursors(on: B2).map { [$0.cursor.x, $0.cursor.y] } == [[500, 500]])
}

@MainActor @Test func draggedPositionsPlayBackAndTextShowsOnArrival() {
  let (relay, clock, a, b) = two()
  a.hold([C1])
  for (x, text) in [(0.0, "a"), (10, "ab"), (20, "abc")] {
    a.sendLive(board: B1, items: [C1: ["pos": pos(x, 0), "text": .string(text)]], caret: nil)
    relay.run()
    clock.advance(0.05)
  }
  clock.advance(-0.025)
  #expect(b.overlay(on: B1)[C1] == ["pos": pos(15, 0), "text": .string("abc")])
}

@MainActor @Test func coordinatesFarOutAreClampedSoThatPlayingBackStaysFinite() {
  let (relay, clock, a, b) = two()
  a.hold([C1])
  a.sendCursor(board: B1, x: 1e308, y: 0)
  a.sendLive(board: B1, items: [C1: ["pos": pos(1e308, -1e308)]], caret: nil)
  relay.run()
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [1e7])
  #expect(b.overlay(on: B1)[C1] == ["pos": pos(1e7, -1e7)])
  clock.advance(0.05)
  a.sendCursor(board: B1, x: -1e308, y: 0)
  a.sendLive(board: B1, items: [C1: ["pos": pos(-1e308, 1e308)]], caret: nil)
  relay.run()
  clock.advance(0.025)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [0])
  #expect(b.overlay(on: B1)[C1] == ["pos": pos(0, 0)])
}

@MainActor @Test func duplicatesAndLateBodiesAreDroppedAndBodiesWithoutSeqOrAtAreTaken() throws {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: B1, x: 5, y: 5)
  relay.run()
  let late = relay.frames.last!
  clock.advance(0.2)
  a.sendCursor(board: B1, x: 9, y: 9)
  relay.run()
  // the first cursor again, as an unordered channel may deliver it late
  relay.resend(late)
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [9])
  // as a client from before this design sends it
  try inject(relay, from: a, ["t": .string("cursor"), "board": .string(B1), "x": .number(3), "y": .number(3)])
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [3])
}

@MainActor @Test func aSeqThatIsNotAnIntegerInRangeIsTreatedAsAbsent() throws {
  let (relay, clock, a, b) = two()
  for (i, seq) in [1e30, 1.5].enumerated() {
    try inject(relay, from: a, ["t": .string("cursor"), "board": .string(B1), "x": .number(Double(i + 1)), "y": .number(0), "seq": .number(seq)])
    clock.advance(0.2)
    #expect(b.cursors(on: B1).map { $0.cursor.x } == [Double(i + 1)])
  }
}

@MainActor @Test func numbersAPeerSendsThatCannotBePlayedBackOrReadExactlyAreIgnored() throws {
  let (relay, clock, a, b) = two()
  var pushes: [Int] = []
  b.onPushed = { v, _ in pushes.append(v) }
  a.hold([C1, C2])
  relay.run()
  let bad: JSONValue = .object(["id": .string(C1), "back": .bool(false), "at": .number(1e300)])
  try inject(relay, from: a, [
    "t": .string("live"), "board": .string(B1), "caret": bad,
    "items": .object([C1: .object(["w": .number(100), "pos": pos(0, 0)]), C2: .object(["w": .array([])])]),
  ])
  clock.advance(0.05)
  try inject(relay, from: a, [
    "t": .string("live"), "board": .string(B1), "caret": .null,
    "items": .object([C1: .object(["w": .array([]), "pos": .array([.number(10), .number(0), .number(5)])])]),
  ])
  clock.advance(0.2)
  #expect(b.overlay(on: B1) == [C1: ["w": .number(100), "pos": pos(0, 0)], C2: ["w": .array([])]])
  #expect(b.carets(on: B1).isEmpty)
  try inject(relay, from: a, ["t": .string("live"), "board": .string(B1), "items": .object([:]), "caret": bad])
  #expect(b.carets(on: B1).isEmpty)
  try inject(relay, from: a, ["t": .string("pushed"), "version": .number(1e300)])
  #expect(pushes.isEmpty)
  // a seq too big to read exactly is no seq at all, so later bodies still arrive
  try inject(relay, from: a, ["t": .string("cursor"), "board": .string(B1), "x": .number(1), "y": .number(1), "seq": .number(1e300), "at": .number(0)])
  clock.advance(0.05)
  a.sendCursor(board: B1, x: 2, y: 2)
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [2])
}

/// `n` devices with fake transports, all on board B1, the last one the newcomer; through a relay from before the lean
/// sync design when `oldRelay`.
@MainActor private func direct(_ n: Int = 2, oldRelay: Bool = false) -> (FakeRelay, Clock, [FakePeerTransport], [Live]) {
  let clock = Clock(), relay = FakeRelay(clock: clock, old: oldRelay)
  var ts: [FakePeerTransport] = [], ls: [Live] = []
  for i in 0..<n {
    let t = FakePeerTransport()
    let l = live(relay, clock, name: "P\(i)", transport: t)
    l.connect()
    relay.run()
    l.setPresence(board: B1, selection: [])
    relay.run()
    ts.append(t)
    ls.append(l)
  }
  return (relay, clock, ts, ls)
}

/// Opens the channel between devices i and j, both ways.
@MainActor private func open(_ ts: [FakePeerTransport], _ ls: [Live], _ i: Int, _ j: Int) {
  ts[i].onState?(ls[j].id!, .open)
  ts[j].onState?(ls[i].id!, .open)
}

/// Makes the channel between devices i and j, j the newer, an older device's: an offer and an answer without a version.
@MainActor private func oldChannel(_ relay: FakeRelay, _ ls: [Live], _ i: Int, _ j: Int) throws {
  try inject(relay, from: ls[j], ["t": .string("offer"), "sdp": .string("old offer")], to: ls[i].id)
  try inject(relay, from: ls[i], ["t": .string("answer"), "sdp": .string("old answer")], to: ls[j].id)
}

/// Cursors and live edits device `l` sent through the relay.
@MainActor private func relayed(_ relay: FakeRelay, _ l: Live) -> [Sent] { fast(sentBy(relay, l.id)) }

@MainActor private func deliver(_ ts: [FakePeerTransport], _ ls: [Live], from i: Int = 0, to j: Int = 1) -> [PeerMessage] {
  let sent = ts[i].sent.map(\.message)
  ts[i].sent = []
  for m in sent { ts[j].onMessage?(ls[i].id!, m) }
  return sent
}

private func data(_ m: PeerMessage?) -> Data? {
  guard case let .bytes(d) = m else { return nil }
  return d
}

private func unpack(_ m: PeerMessage?) -> [Pack] { data(m).flatMap { try? Pack.unpack($0).array } ?? [] }

@MainActor @Test func theNewcomerOffersThroughTheRelayAndTheOthersAnswer() {
  let (_, _, ts, ls) = direct()
  #expect(Array(ts[1].log.prefix(2)) == ["create \(ls[0].id!)", "offer \(ls[0].id!)"])
  #expect(Array(ts[0].log.prefix(2)) == ["create \(ls[1].id!)", "answer \(ls[1].id!) offer-sdp \(ls[0].id!)"])
  #expect(ts[1].log.contains("accept \(ls[0].id!) answer-sdp \(ls[1].id!)"))
}

@MainActor @Test func withEveryChannelOpenCursorsGoOnlyDirectAndEveryFrame() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(Live.directSendInterval)
  ls[0].sendCursor(board: B1, x: 2, y: 2)
  relay.run()
  #expect(relayed(relay, ls[0]).isEmpty)
  #expect(ts[0].sent.count == 2)
  #expect(ts[0].sent.allSatisfy { data($0.message) != nil })
  _ = deliver(ts, ls)
  relay.run()
  clock.advance(0.2)
  #expect(ls[1].cursors(on: B1).map { $0.cursor.x } == [2])
}

@MainActor @Test func withAChannelShortCursorsGoToTheRelayToo() {
  let (relay, _, ts, ls) = direct(3)
  open(ts, ls, 0, 1)
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  #expect(relayed(relay, ls[0]).map(\.to) == [Int(ls[2].id!)])
  #expect(ts[0].sent.map(\.id) == [ls[1].id!])
}

@MainActor @Test func whileHoldingTheHeartbeatGoesToTheRelayEvenWithEveryChannelOpen() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold([C1])
  ls[0].sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  clock.advance(5)
  ls[0].tick()
  relay.run()
  #expect(alives(relay, ls[0].id) == 1)
}

@MainActor @Test func aLongGestureWithEveryChannelOpenStillReachesTheRelayEvery5s() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold([C1])
  relay.run()
  for t in stride(from: 0, to: 12_000, by: 8) {
    ls[0].sendLive(board: B1, items: [C1: ["pos": pos(Double(t), 0)]], caret: nil)
    relay.run()
    clock.advance(Live.directSendInterval)
    if t % 1000 == 0 { ls[0].tick() }
  }
  relay.run()
  #expect(alives(relay, ls[0].id) >= 2)
}

@MainActor @Test func aLiveEditThatComesDirectBeforeItsHoldIsShownAndKeepsItsTrackAndOneNeverHeldGoesAfterASecond() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  // the gates' next turn, without the relay
  let send = {
    clock.advance(0)
    _ = deliver(ts, ls)
  }
  ls[0].hold([C1])
  ls[0].sendLive(board: B1, items: [C1: ["pos": pos(0, 0)]], caret: nil)
  send()
  #expect(ls[1].overlay(on: B1) == [C1: ["pos": pos(0, 0)]])
  relay.run()
  #expect(ls[1].taken == [C1])
  clock.advance(0.05)
  ls[0].sendLive(board: B1, items: [C1: ["pos": pos(10, 0)]], caret: nil)
  send()
  clock.advance(0.025)
  #expect(ls[1].overlay(on: B1)[C1] == ["pos": pos(5, 0)])

  ls[0].sendLive(board: B1, items: [C2: ["pos": pos(1, 1)]], caret: nil)
  send()
  relay.run()
  clock.advance(0.999)
  ls[1].tick()
  #expect(ls[1].overlay(on: B1)[C2] != nil)
  clock.advance(0.001)
  ls[1].tick()
  #expect(Array(ls[1].overlay(on: B1).keys) == [C1])
}

@MainActor @Test func aConnectionThatNeverSpeaksLeavesTheRosterAfter30sAndTheStatusLineCountsTheRoster() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let other = SpaceKeys(space: randomBytes(16), secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
  let stranger = live(relay, clock, keys: other)
  stranger.connect()
  relay.run()
  #expect(ls[0].directStatus == "Direct with 1 of 2 people")
  for _ in 0..<29 {
    clock.advance(1)
    for l in ls + [stranger] { l.tick() }
    relay.run()
  }
  #expect(ls[0].directStatus == "Direct with 1 of 2 people")
  clock.advance(1)
  for l in ls + [stranger] { l.tick() }
  relay.run()
  #expect(ls[0].directStatus == "Direct with 1 of 1 person")
}

@MainActor @Test func withEveryChannelOpenTheLastCursorGoesOnceMore100msLaterAsAChannelMayLoseIt() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let seq = { (m: PeerMessage) in unpack(m)[1].int }
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(Live.directSendInterval)
  ls[0].sendCursor(board: B1, x: nil, y: nil)
  relay.run()
  ts[1].onMessage?(ls[0].id!, ts[0].sent[0].message)
  clock.advance(0.099)
  relay.run()
  #expect(ts[0].sent.count == 2)
  clock.advance(0.001)
  relay.run()
  #expect(ts[0].sent.count == 3)
  #expect(seq(ts[0].sent[2].message)! > seq(ts[0].sent[1].message)!)
  ts[1].onMessage?(ls[0].id!, ts[0].sent[2].message)
  relay.run()
  #expect(ls[1].cursors(on: B1).isEmpty)
  clock.advance(1)
  relay.run()
  #expect(ts[0].sent.count == 3)
}

@MainActor @Test func onlyCursorsAndLiveEditsAreTakenFromAChannelAndOnlyCompactOnesFromAVersion2Channel() throws {
  let sealed = { (b: String) in try keys().sealLive(Data(b.utf8)) }
  let (relay, _, ts, ls) = direct()
  try oldChannel(relay, ls, 0, 1)
  open(ts, ls, 0, 1)
  var pushes: [Int] = []
  ls[1].onPushed = { v, _ in pushes.append(v) }
  ts[1].onMessage?(ls[0].id!, .text(Base64URL.encode(try sealed(#"{"t":"pushed","version":9}"#))))
  relay.run()
  #expect(pushes.isEmpty)
  let (now, _, nts, nls) = direct()
  open(nts, nls, 0, 1)
  let cursor = #"{"t":"cursor","board":"\#(B1)","x":1,"y":1}"#
  nts[1].onMessage?(nls[0].id!, .bytes(Data(cursor.utf8)))
  nts[1].onMessage?(nls[0].id!, .bytes(try sealed(cursor)))
  now.run()
  #expect(nls[1].cursors(on: B1).isEmpty)
}

@MainActor @Test func aPeerLeavingClosesItsConnectionAndTheStatusLineCountsOpenChannels() {
  let (relay, _, ts, ls) = direct()
  #expect(ls[0].directStatus == "Direct with 0 of 1 person")
  open(ts, ls, 0, 1)
  #expect(ls[0].directStatus == "Direct with 1 of 1 person")
  let gone = ls[1].id!
  ls[1].close()
  relay.run()
  #expect(ts[0].log.contains("close \(gone)"))
  #expect(ls[0].directStatus == nil)
}

@MainActor @Test func pushedCarriesItsRecordsToTheOthersUnlessTheyWouldNotFitAFrame() throws {
  let (relay, _, a, b) = two()
  var got: [(Int, Pushed?)] = []
  b.onPushed = { got.append(($0, $1)) }
  let records = [Pulled(id: "AAAA", version: 5, blob: "BBBB")]
  a.sendPushed(Pushed(version: 5, epoch: "e", records: records))
  relay.run()
  a.sendPushed(Pushed(version: 6, epoch: "e", records: [Pulled(id: "AAAA", version: 6, blob: String(repeating: "x", count: 61_000))]))
  relay.run()
  try inject(relay, from: a, ["t": .string("pushed"), "version": .number(7), "epoch": .string("e"), "records": .array([
    .object(["id": .number(1), "version": .number(7), "blob": .string("x")]),
  ])])
  #expect(got.map(\.0) == [5, 6, 7])
  #expect(got[0].1 == Pushed(version: 5, epoch: "e", records: records))
  #expect(got[1].1 == nil)
  #expect(got[2].1 == nil)
}

@MainActor @Test func presenceSaysTheVersionAndBoardsWithoutAColourAndPeopleStillHaveTheirs() {
  let (relay, _, a, b) = two()
  let presence = sentBy(relay, a.id).last { $0.body["t"]?.string == "presence" }!.body
  #expect(presence["colour"] == nil)
  #expect(presence["v"] == .number(2))
  #expect(presence["boards"] == .array([.string(B1)]))
  #expect(b.people(on: B1).first?.colour == colour(a.me.device))
}

@MainActor @Test func aDeviceShowingTwoBoardsSaysSoAndGetsCursorsAndLiveEditsOnBoth() {
  let (relay, clock, mac, b) = two()
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: B1, selection: [])
  mac.setPresence(board: B1, boards: [B1, B2], selection: [])
  b.setPresence(board: B2, selection: [])
  relay.run()
  let presence = sentBy(relay, mac.id).last { $0.body["t"]?.string == "presence" }!.body
  #expect(presence["board"] == .string(B1) && presence["boards"] == .array([.string(B1), .string(B2)]))
  b.sendCursor(board: B2, x: 5, y: 5)
  b.hold([C1])
  b.sendLive(board: B2, items: moved, caret: nil)
  relay.run()
  clock.advance(0.05)
  b.sendCursor(board: B2, x: 6, y: 6)
  relay.run()
  clock.advance(0.2)
  #expect(mac.cursors(on: B2).map { [$0.cursor.x, $0.cursor.y] } == [[6, 6]])
  #expect(mac.overlay(on: B2) == moved)
  // the live edit and the first cursor on B2 went in one gate window: the cursor to everyone, the rest only to the Mac
  #expect(fast(sentBy(relay, b.id)).map { [$0.body["t"]?.string, $0.to.map { String($0) }] } == [["live", mac.id], ["cursor", nil], ["cursor", mac.id]])
  #expect(c.overlay(on: B2).isEmpty)
}

@MainActor @Test func anOlderDeviceGetsJSONCursorsAndLiveEditsAndSeesThemAndACurrentOneGetsCompactAndBothSeeTheSame() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let old = OldDevice(relay, keys: keys(), name: "Olga")
  old.connect()
  relay.run()
  old.presence(B1)
  relay.run()
  ls[0].hold([C1])
  ls[0].sendCursor(board: B1, x: 10.5, y: 20.25)
  relay.run()
  clock.advance(0.05)
  ls[0].sendCursor(board: B1, x: 11.5, y: 21.25)
  ls[0].sendLive(board: B1, items: [C1: ["pos": pos(30.5, 40.75)]], caret: nil)
  relay.run()
  #expect(ts[0].sent.allSatisfy { data($0.message).map(Compact.isCompact) == true })
  _ = deliver(ts, ls)
  relay.run()
  clock.advance(0.2)
  #expect(old.unreadable == 0)
  #expect(old.last("presence")?["colour"] == nil)
  #expect(old.last("cursor").map { [$0["x"], $0["y"]] } == [.number(11.5), .number(21.25)])
  #expect(old.last("live")?["items"] == .object([C1: .object(["pos": pos(30.5, 40.75)])]))
  #expect(ls[1].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[11.5, 21.25]])
  #expect(ls[1].overlay(on: B1)[C1] == ["pos": pos(30.5, 40.75)])

  old.send(["t": .string("cursor"), "board": .string(B1), "x": .number(7), "y": .number(8), "seq": .number(1), "at": .number(1)])
  relay.run()
  #expect(ls[0].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[7, 8]])
  #expect(ls[0].people(on: B1).first { $0.name == "Olga" }?.colour == colour(old.device))
}

@MainActor @Test func jsonBodiesCarryCoordinatesTo001AndTimesTo01ms() {
  let (relay, clock, _, ls) = direct(1)
  let a = ls[0]
  let old = OldDevice(relay, keys: keys())
  old.connect()
  relay.run()
  old.presence(B1)
  relay.run()
  clock.advance(0.00123456)
  a.hold([C1])
  a.sendCursor(board: B1, x: 1.23456, y: 2.34567)
  a.sendLive(board: B1, items: [C1: ["pos": pos(3.45678, 4.56789), "w": .number(5.67891)]], caret: nil)
  relay.run()
  let cursor = old.last("cursor")!, body = old.last("live")!
  #expect([cursor["x"], cursor["y"]] == [.number(1.23), .number(2.35)])
  #expect(body["items"]?.object?[C1] == .object(["pos": pos(3.46, 4.57), "w": .number(5.68)]))
  let at = clock.now.timeIntervalSince1970 * 1000 - a.started
  #expect(cursor["at"] == .number((at * 10).rounded() / 10))
}

@MainActor @Test func aChannelToAnOlderDeviceCarriesSealedJSONTextBothWays() throws {
  let (relay, clock, ts, ls) = direct()
  try oldChannel(relay, ls, 0, 1)
  open(ts, ls, 0, 1)
  #expect(ls[0].direct?.version(ls[1].id!) == 1 && ls[1].direct?.version(ls[0].id!) == 1)
  ls[0].sendCursor(board: B1, x: 1, y: 2)
  ls[1].sendCursor(board: B1, x: 3, y: 4)
  relay.run()
  #expect(!ts[0].sent.isEmpty && !ts[1].sent.isEmpty)
  #expect((ts[0].sent + ts[1].sent).allSatisfy { if case .text = $0.message { true } else { false } })
  _ = deliver(ts, ls, from: 0, to: 1)
  _ = deliver(ts, ls, from: 1, to: 0)
  relay.run()
  clock.advance(0.2)
  #expect(ls[1].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[1, 2]])
  #expect(ls[0].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[3, 4]])
}

@MainActor @Test func relayFramesAreBinaryAndACompactCursorIsAtMost60BFromTheRelayAnd24BOnAChannel() {
  let (relay, clock, a, _) = two()
  for x in [1.0, 2] {
    a.sendCursor(board: B1, x: x, y: x)
    relay.run()
    clock.advance(0.05)
  }
  #expect(relay.frames.filter { $0.from == a.id }.allSatisfy { !($0.text?.contains("\"body\"") ?? false) })
  let cursors = fast(sentBy(relay, a.id))
  #expect(cursors.count == 2)
  #expect(cursors[1].size <= 60, "\(cursors[1].size) B")

  let (drelay, dclock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  for x in [1.0, 2] {
    ls[0].sendCursor(board: B1, x: x, y: x)
    drelay.run()
    dclock.advance(Live.directSendInterval)
  }
  let size = data(ts[0].sent[1].message)?.count ?? .max
  #expect(size <= 24, "\(size) B")
}

@MainActor @Test func withOnePeerOnAChannelAndOneOnTheRelayTheChannelGetsABodyEvery8msAndTheRelayEvery50ms() {
  let (relay, clock, ts, ls) = direct(3)
  open(ts, ls, 0, 1)
  for t in stride(from: 0, to: 100, by: 8) {
    ls[0].sendCursor(board: B1, x: Double(t), y: 0)
    relay.run()
    clock.advance(Live.directSendInterval)
  }
  relay.run()
  #expect(ts[0].sent.filter { $0.id == ls[1].id }.count == 13)
  #expect(relayed(relay, ls[0]).map(\.to) == Array(repeating: Int(ls[2].id!), count: 3))
}

@MainActor @Test func cursorsGoToThoseOnTheirBoardTheFirstOnAnotherBoardGoesToEveryoneAndOneShowingBothGetsBoth() {
  let (relay, clock, ts, ls) = direct(4)
  for j in [1, 2, 3] { open(ts, ls, 0, j) }
  ls[2].setPresence(board: B2, selection: [])
  ls[3].setPresence(board: B1, boards: [B1, B2], selection: [])
  relay.run()
  let all = [1, 2, 3]
  for (board, to) in [(B1, all), (B1, [1, 3]), (B2, all), (B2, [2, 3])] {
    ls[0].sendCursor(board: board, x: 1, y: 1)
    relay.run()
    clock.advance(Live.directSendInterval)
    #expect(ts[0].sent.map(\.id).sorted() == to.map { ls[$0].id! }.sorted())
    ts[0].sent = []
  }
  #expect(relayed(relay, ls[0]).isEmpty)
}

@MainActor @Test func throughTheRelayNobodyOnTheBoardGetsNothingOneGetsAFrameWithToMoreGetABroadcast() {
  let (relay, clock, a, b) = two()
  b.setPresence(board: B2, selection: [])
  relay.run()
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(0.05)
  a.sendCursor(board: B1, x: 2, y: 2)
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  clock.advance(0.05)
  // the first cursor on B1 tells everyone this device's cursor left where it was
  #expect(sentBy(relay, a.id).filter { $0.body["t"]?.string != "presence" }.map(\.to) == [Int(b.id!)])
  b.setPresence(board: B1, selection: [])
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: B1, selection: [])
  relay.run()
  a.sendCursor(board: B1, x: 3, y: 3)
  // B's presence came before C joined, so the relay's gate is still shut from catching B up
  clock.advance(0.05)
  relay.run()
  let last = fast(sentBy(relay, a.id)).last
  #expect(last?.to == nil && last?.body["cursor"] == pos(3, 3))
  c.setPresence(board: B2, selection: [])
  relay.run()
  clock.advance(0.05)
  a.sendCursor(board: B1, x: 5, y: 5)
  relay.run()
  #expect(fast(sentBy(relay, a.id)).last?.to == Int(b.id!))
}

@MainActor @Test func duringAGestureOverAChannelOneBodyAFrameCarriesTheLiveEditAndTheCursorAndTheCursorFollows() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold([C1])
  ls[0].sendCursor(board: B1, x: 100, y: 50)
  relay.run()
  _ = deliver(ts, ls)
  relay.run()
  for i in 1...5 {
    clock.advance(Live.directSendInterval)
    ls[0].sendCursor(board: B1, x: 100 + Double(i) * 10, y: 50)
    ls[0].sendLive(board: B1, items: [C1: ["pos": pos(Double(i) * 10, 0)]], caret: nil, starts: [C1: [0, 0]])
    relay.run()
    let sent = deliver(ts, ls)
    relay.run()
    #expect(sent.count == 1)
    let v = unpack(sent.first)
    #expect(v.first?.int == 2)
    #expect(v.count == 8 && v[7].array?.compactMap(\.number) == [100 + Double(i) * 10, 50])
  }
  clock.advance(0.2)
  #expect(ls[1].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[150, 50]])
  #expect(ls[1].overlay(on: B1)[C1] == ["pos": pos(50, 0)])
  // the folded cursors left the cursor stream as it was: the cursor bodies after, the resend 100 ms on too, are no
  // keyframes
  ls[0].release()
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  let sizes = ts[0].sent.map { data($0.message)?.count ?? .max }
  #expect(sizes.count == 2 && sizes.allSatisfy { $0 <= 24 }, "\(sizes)")
}

@MainActor @Test func typingIntoALongCardSendsSplicesAndOneLostLeavesTheTextAsItWasUntilTheNextKeyframe() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold([C1])
  relay.run()
  let base = String(repeating: "x", count: 560)
  var text = base
  var sizes: [Int] = [], seen: [String?] = []
  func type(_ delivered: Bool = true) {
    ls[0].sendLive(board: B1, items: [C1: ["text": .string(text)]], caret: Caret(id: C1, back: false, at: text.utf16.count))
    relay.run()
    let body = ts[0].sent.first!.message
    ts[0].sent = []
    sizes.append(data(body)?.count ?? .max)
    if delivered { ts[1].onMessage?(ls[0].id!, body) }
    relay.run()
    seen.append(ls[1].overlay(on: B1)[C1]?["text"]?.string)
    clock.advance(Live.directSendInterval)
  }
  for i in 0..<20 {
    text += "y"
    type(i != 10)
  }
  #expect(sizes.dropFirst().allSatisfy { $0 <= 60 }, "\(sizes)")
  #expect(seen[9] == base + String(repeating: "y", count: 10))
  #expect(seen[10...].allSatisfy { $0 == seen[9] })
  clock.advance(1)
  type()
  #expect(seen.last == text)
}

@MainActor @Test func draggingThreeCardsSendsTheOffsetOnlyAndTheReceiverPutsAllThree() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let starts: [String: [Double]] = [C1: [0, 0], C2: [0, 100], C3: [0, 200]]
  ls[0].hold([C1, C2, C3])
  ls[0].sendCursor(board: B1, x: 0, y: 0)
  relay.run()
  ts[0].sent = []
  var sizes: [Int] = []
  for i in 1...10 {
    clock.advance(Live.directSendInterval)
    let dx = Double(i) * 5
    ls[0].sendCursor(board: B1, x: dx, y: 10)
    ls[0].sendLive(board: B1, items: starts.mapValues { ["pos": pos($0[0] + dx, $0[1])] }, caret: nil, starts: starts)
    relay.run()
    let sent = deliver(ts, ls)
    relay.run()
    #expect(sent.count == 1)
    sizes.append(data(sent.first)?.count ?? .max)
    if i > 1 { #expect(unpack(sent.first)[5].map?.isEmpty == true) }
  }
  #expect(sizes.dropFirst().allSatisfy { $0 <= 40 }, "\(sizes)")
  clock.advance(0.2)
  #expect(ls[1].overlay(on: B1).mapValues { $0["pos"] } == [C1: pos(50, 0), C2: pos(50, 100), C3: pos(50, 200)])
}

@MainActor @Test func draggingOneCardSendsItsOffsetOnlyAtMost32BOnAChannelAnd64BFromTheRelay() {
  let (drelay, dclock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold([C1])
  ls[0].sendCursor(board: B1, x: 0, y: 0)
  drelay.run()
  ts[0].sent = []
  var sizes: [Int] = []
  for i in 1...10 {
    dclock.advance(Live.directSendInterval)
    let x = Double(i) * 5
    ls[0].sendCursor(board: B1, x: x, y: 10)
    ls[0].sendLive(board: B1, items: [C1: ["pos": pos(x, 0)]], caret: nil, starts: [C1: [0, 0]])
    drelay.run()
    let sent = deliver(ts, ls)
    drelay.run()
    #expect(sent.count == 1)
    sizes.append(data(sent.first)?.count ?? .max)
    #expect(unpack(sent.first)[5].map?.isEmpty == true)
  }
  #expect(sizes.dropFirst().allSatisfy { $0 <= 32 }, "\(sizes)")
  dclock.advance(0.2)
  #expect(ls[1].overlay(on: B1)[C1] == ["pos": pos(50, 0)])

  let (relay, clock, a, b) = two()
  a.hold([C1])
  for i in 1...10 {
    clock.advance(0.05)
    let x = Double(i) * 5
    a.sendCursor(board: B1, x: x, y: 10)
    a.sendLive(board: B1, items: [C1: ["pos": pos(x, 0)]], caret: nil, starts: [C1: [0, 0]])
    relay.run()
  }
  let bodies = fast(sentBy(relay, a.id)).filter { $0.body["t"]?.string == "live" }.map(\.size)
  #expect(bodies.count == 10)
  #expect(bodies.dropFirst().allSatisfy { $0 <= 64 }, "\(bodies)")
  clock.advance(0.2)
  #expect(b.overlay(on: B1)[C1] == ["pos": pos(50, 0)])
}

@MainActor @Test func aBodyThatCannotBePutCompactlyIsNotSent() {
  let (relay, _, ts, ls) = direct(3)
  open(ts, ls, 0, 1)
  ls[0].sendCursor(board: "not an id", x: 1, y: 1)
  relay.run()
  #expect(ts[0].sent.isEmpty)
  #expect(relayed(relay, ls[0]).isEmpty)
}

@MainActor @Test func aPeerThatComesBackToTheBoardGetsTheCursorAsItIsNowHiddenToo() {
  let (relay, clock, a, b) = two()
  b.setPresence(board: B2, selection: [])
  relay.run()
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(0.05)
  #expect(b.cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[1, 1]])
  a.sendCursor(board: B1, x: 50, y: 50)
  relay.run()
  clock.advance(0.05)
  a.sendCursor(board: B1, x: nil, y: nil)
  relay.run()
  clock.advance(0.05)
  b.setPresence(board: B1, selection: [])
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: B1).isEmpty)
}

@MainActor @Test func aPeerThatComesOntoTheBoardMidDragGetsTheOverlayWithoutTheHolderMoving() {
  let (relay, clock, a, b) = two()
  b.setPresence(board: B2, selection: [])
  relay.run()
  a.hold([C1])
  a.sendLive(board: B1, items: [C1: ["pos": pos(10, 0), "text": .string("hi")]], caret: nil)
  relay.run()
  #expect(b.overlay(on: B1).isEmpty)
  b.setPresence(board: B1, selection: [])
  relay.run()
  clock.advance(0.05)
  relay.run()
  clock.advance(0.2)
  #expect(b.overlay(on: B1)[C1] == ["pos": pos(10, 0), "text": .string("hi")])
}

@MainActor @Test func aPeerWhoseBoardsGainTheBoardGetsTheCursorAndTheLiveEdit() {
  let (relay, clock, a, b) = two()
  b.setPresence(board: B2, boards: [B2], selection: [])
  relay.run()
  a.sendCursor(board: B2, x: 0, y: 0)
  relay.run()
  clock.advance(0.05)
  a.sendCursor(board: B1, x: 5, y: 5)
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  clock.advance(0.05)
  a.sendCursor(board: B1, x: 6, y: 6)
  relay.run()
  clock.advance(0.05)
  b.setPresence(board: B2, boards: [B2, B1], selection: [])
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[6, 6]])
  #expect(b.overlay(on: B1) == moved)
}

@MainActor @Test func anOlderDeviceAndACurrentOneBothOnTheRelayGetOneJSONBroadcastThatBothRead() {
  let (relay, clock, a, b) = two()
  let old = OldDevice(relay, keys: keys())
  old.connect()
  relay.run()
  old.presence(B1)
  relay.run()
  a.sendCursor(board: B1, x: 3, y: 4)
  relay.run()
  clock.advance(0.2)
  let sent = fast(sentBy(relay, a.id))
  #expect(sent.count == 1)
  #expect(sent.first?.to == nil)
  #expect(sent.first?.body["t"] == .string("cursor") && sent.first?.body["x"] == .number(3))
  #expect(old.last("cursor").map { [$0["x"], $0["y"]] } == [.number(3), .number(4)])
  #expect(b.cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[3, 4]])
}

/// The last body device `l` sent through the relay, unpacked.
@MainActor private func lastRelayed(_ relay: FakeRelay, _ l: Live) -> [Pack] {
  let f = relay.frames.last { $0.from == l.id && $0.bytes != nil }!
  return (try? Pack.unpack(keys().openLive(FakeRelay.parse(f.bytes!)!.body)).array) ?? []
}

/// Field `key` of the first item in an unpacked live body.
private func firstItem(_ v: [Pack], _ key: Int64) -> Pack? { v[5].map?.first?.1.map?.first { $0.0 == .int(key) }?.1 }

@MainActor @Test func aChannelOpeningOrClosingMidGestureStartsThatPeerOnAKeyframeAndItsOverlayStaysRight() {
  let (relay, clock, ts, ls) = direct()
  ls[0].hold([C1])
  func drag(_ x: Double) {
    clock.advance(0.05)
    ls[0].sendLive(board: B1, items: [C1: ["pos": pos(x, 0), "text": .string("hello")]], caret: nil)
    relay.run()
  }
  drag(0)
  drag(10)
  #expect(lastRelayed(relay, ls[0])[3] == .null)
  open(ts, ls, 0, 1)
  drag(20)
  let body = ts[0].sent.first?.message
  ts[0].sent = []
  let v = unpack(body)
  #expect(v[3].bin != nil)
  #expect(firstItem(v, 3) == .string("hello"))
  ts[1].onMessage?(ls[0].id!, body!)
  relay.run()
  ts[0].onState?(ls[1].id!, .closed)
  ts[1].onState?(ls[0].id!, .closed)
  drag(30)
  let r = lastRelayed(relay, ls[0])
  #expect(r[3].bin != nil)
  #expect(firstItem(r, 3) == .string("hello"))
  clock.advance(0.2)
  #expect(ls[1].overlay(on: B1)[C1] == ["pos": pos(30, 0), "text": .string("hello")])
}

@MainActor @Test func aCursorInsideALiveBodyThatIsNotNewerThanTheLastCursorIsIgnored() throws {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  for x in [1.0, 2, 3] {
    ls[0].sendCursor(board: B1, x: x, y: x)
    relay.run()
    clock.advance(Live.directSendInterval)
  }
  _ = deliver(ts, ls)
  relay.run()
  let stale = try LiveEncoder().encode(LiveBody(board: B1, items: [:], cursor: [999, 999]), seq: 1, at: 0, now: clock.now)
  ts[1].onMessage?(ls[0].id!, .bytes(stale))
  relay.run()
  clock.advance(0.2)
  #expect(ls[1].cursors(on: B1).map { [$0.cursor.x, $0.cursor.y] } == [[3, 3]])
}

@MainActor @Test func aChannelThatOpensAndClosesBetweenTwoRelayBodiesStartsTheRelayOverOnAKeyframe() {
  let (relay, clock, ts, ls) = direct()
  ls[0].hold([C1])
  relay.run()
  var text = String(repeating: "x", count: 100)
  func type() {
    text += "y"
    ls[0].sendLive(board: B1, items: [C1: ["text": .string(text)]], caret: nil)
    relay.run()
  }
  type()
  clock.advance(0.05)
  type()
  open(ts, ls, 0, 1)
  clock.advance(Live.directSendInterval)
  type()
  _ = deliver(ts, ls)
  relay.run()
  ts[0].onState?(ls[1].id!, .closed)
  ts[1].onState?(ls[0].id!, .closed)
  type()
  clock.advance(0.05)
  relay.run()
  #expect(ls[1].overlay(on: B1)[C1]?["text"]?.string == text)
}

@MainActor @Test func onARelayFromBeforeTheLeanSyncDesignCurrentDevicesSendJSONFramesAndSeePresenceCursorsLiveEditsAndPushes() {
  let (relay, clock, a, b) = two(old: true)
  #expect(a.id?.allSatisfy(\.isNumber) == false)
  #expect(b.people(on: B1).map(\.name) == ["Ana Lima"])
  a.sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: B1).map { $0.cursor.x } == [1])
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  #expect(b.overlay(on: B1) == moved)
  var got: [(Int, Pushed?)] = []
  b.onPushed = { got.append(($0, $1)) }
  let records = [Pulled(id: "AAAA", version: 5, blob: "BBBB")]
  a.sendPushed(Pushed(version: 5, epoch: "e", records: records))
  relay.run()
  #expect(got.map(\.0) == [5])
  #expect(got.first?.1 == Pushed(version: 5, epoch: "e", records: records))
  #expect(relay.frames.allSatisfy { $0.bytes == nil })
}

@MainActor @Test func onARelayFromBeforeTheLeanSyncDesignAHoldersHoldsLastThroughALongGestureToOthersThere() {
  let (relay, clock, a, b) = two(old: true)
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: B1, selection: [])
  a.hold([C1])
  relay.run()
  for t in stride(from: 0, to: 12_000, by: 50) {
    a.sendLive(board: B1, items: [C1: ["pos": pos(Double(t), 0)]], caret: nil)
    relay.run()
    clock.advance(Live.sendInterval)
    if t % 1000 == 0 {
      a.tick()
      relay.sweep()
      relay.run()
    }
  }
  #expect(b.taken == [C1])
  #expect(c.overlay(on: B1)[C1] == ["pos": pos(11_950, 0)])
}

@MainActor @Test func onARelayFromBeforeTheLeanSyncDesignCurrentDevicesOpenADirectChannel() {
  let (relay, clock, ts, ls) = direct(oldRelay: true)
  #expect(ts[1].log.contains("accept \(ls[0].id!) answer-sdp \(ls[1].id!)"))
  open(ts, ls, 0, 1)
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  #expect(!ts[0].sent.isEmpty && ts[0].sent.allSatisfy { $0.id == ls[1].id! && data($0.message) != nil })
  _ = deliver(ts, ls)
  relay.run()
  clock.advance(0.2)
  #expect(ls[1].cursors(on: B1).map { $0.cursor.x } == [1])
}

@MainActor @Test func holdingAgainAsWhenDraggingTheCardJustEditedBeforeTheEditsPushReleasesItStartsOnAKeyframe() {
  let (relay, clock, a, _) = two()
  a.hold([C1])
  a.sendLive(board: B1, items: [C1: ["text": .string("hello")]], caret: nil)
  relay.run()
  clock.advance(Live.sendInterval)
  a.sendLive(board: B1, items: [C1: ["text": .string("hello!")]], caret: nil)
  relay.run()
  #expect(lastRelayed(relay, a)[3] == .null)
  clock.advance(Live.sendInterval)
  a.hold([C1])
  a.sendLive(board: B1, items: moved, caret: nil)
  relay.run()
  #expect(lastRelayed(relay, a)[3].bin != nil)
}

@MainActor @Test func theChannelsRepeatOfTheFirstCursorOnAnotherBoardGoesToEveryoneToo() {
  let (relay, clock, ts, ls) = direct(3)
  for j in [1, 2] { open(ts, ls, 0, j) }
  ls[2].setPresence(board: B2, selection: [])
  relay.run()
  ls[0].sendCursor(board: B1, x: 1, y: 1)
  relay.run()
  clock.advance(0.2)
  relay.run()
  ts[0].sent = []
  ls[0].sendCursor(board: B2, x: 1, y: 1)
  relay.run()
  let everyone = [ls[1].id!, ls[2].id!].sorted()
  #expect(ts[0].sent.map(\.id).sorted() == everyone)
  ts[0].sent = []
  clock.advance(Live.cursorRepeat)
  relay.run()
  #expect(ts[0].sent.map(\.id).sorted() == everyone)
}
