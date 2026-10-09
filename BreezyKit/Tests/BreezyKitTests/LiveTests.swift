import Foundation
import Testing
@testable import BreezyKit

private let space = "QEFCQ0RFRkdISUpLTE1OTw"

private func keys() -> SpaceKeys {
  SpaceKeys(space: Base64URL.decode(space)!, secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
}

@MainActor private func live(_ relay: FakeRelay, _ clock: Clock, name: String = "Ana", device: String = newID(), keys k: SpaceKeys = keys()) -> Live {
  Live(relay: "wss://relay.example/", space: space, keys: k, me: Person(device: device, name: name),
       socket: { relay.connect($0) }, now: { clock.now },
       uptime: { clock.now.timeIntervalSince1970 * 1000 }, schedule: { clock.schedule($0, $1) })
}

/// Two connected devices, both showing board B1.
@MainActor private func two() -> (FakeRelay, Clock, Live, Live) {
  let relay = FakeRelay(), clock = Clock()
  let a = live(relay, clock, name: "Ana Lima"), b = live(relay, clock, name: "Bo")
  a.connect()
  relay.run()
  b.connect()
  relay.run()
  a.setPresence(board: "B1", selection: [])
  b.setPresence(board: "B1", selection: [])
  relay.run()
  return (relay, clock, a, b)
}

private let moved: [String: LiveFields] = ["c1": ["pos": .array([.number(48), .number(0)])]]

@MainActor @Test func peopleSeeEachOtherAndWhatTheyHaveSelected() {
  let (relay, _, a, b) = two()
  #expect(a.connected && b.connected)
  a.setPresence(board: "B1", selection: ["c1"])
  relay.run()
  #expect(b.people(on: "B1").map(\.name) == ["Ana Lima"])
  #expect(b.people(on: "B1").first?.initials == "AL")
  #expect(b.selections(on: "B1")["c1"]?.name == "Ana Lima")
  #expect(a.people(on: "B1").map(\.name) == ["Bo"])
  #expect(a.people(on: "B2").isEmpty)
  #expect(Person(device: newID(), name: " ").initials == "?")
}

@MainActor @Test func cursorsGoAtMostTwentyTimesASecond() {
  let (relay, clock, a, b) = two()
  let before = relay.frames.count
  a.sendCursor(board: "B1", x: 1, y: 1)
  a.sendCursor(board: "B1", x: 2, y: 2)
  a.sendCursor(board: "B1", x: 3, y: 3)
  relay.run()
  #expect(relay.frames.count == before + 1)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [1])
  clock.advance(0.05)
  relay.run()
  #expect(relay.frames.count == before + 2)
  clock.advance(0.2)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [3])
  a.sendCursor(board: "B1", x: nil, y: nil)
  clock.advance(0.05)
  relay.run()
  #expect(b.cursors(on: "B1").isEmpty)
}

@MainActor @Test func aStillCursorFadesAfterAMinute() {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  clock.advance(29)
  a.tick()
  relay.run()
  clock.advance(29)
  a.tick()
  relay.run()
  b.tick()
  #expect(b.cursors(on: "B1").count == 1)
  clock.advance(3)
  b.tick()
  #expect(b.cursors(on: "B1").isEmpty)
  #expect(b.people(on: "B1").count == 1)
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
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: Caret(id: "c1", back: false, at: 3))
  relay.run()
  #expect(b.overlay(on: "B1") == moved)
  #expect(b.overlay(on: "B2").isEmpty)
  #expect(b.carets(on: "B1").map { $0.caret } == [Caret(id: "c1", back: false, at: 3)])
}

@MainActor @Test func theOverlayStaysUntilThePullReachesThePushedVersion() {
  let (relay, _, a, b) = two()
  var pushes: [Int] = []
  b.onPushed = { pushes.append($0) }
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  a.sendPushed(7)
  a.release()
  relay.run()
  #expect(pushes == [7])
  #expect(b.overlay(on: "B1") == moved)
  b.noteCursor(6)
  #expect(b.overlay(on: "B1") == moved)
  b.noteCursor(7)
  #expect(b.overlay(on: "B1").isEmpty)
}

@MainActor @Test func aHoldThatEndsWithoutAPushDropsTheOverlay() {
  let (relay, _, a, b) = two()
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: Caret(id: "c1", back: false, at: 0))
  relay.run()
  relay.lapse(relay.sockets[0])
  relay.run()
  #expect(b.taken.isEmpty)
  #expect(b.overlay(on: "B1").isEmpty)
  #expect(b.carets(on: "B1").isEmpty)
}

@MainActor @Test func anotherConnectionOfTheSameDeviceStillHolds() {
  let relay = FakeRelay(), clock = Clock()
  let device = newID()
  let a = live(relay, clock, device: device), a2 = live(relay, clock, device: device)
  a.connect()
  a2.connect()
  relay.run()
  a.setPresence(board: "B1", selection: [])
  a.hold(["c1"])
  relay.run()
  #expect(a2.taken == ["c1"])
  #expect(a2.people(on: "B1").isEmpty)
}

@MainActor @Test func aPeerThatLeavesOrFallsSilentIsGone() {
  let (relay, clock, a, b) = two()
  a.hold(["c1"])
  relay.run()
  a.close()
  relay.run()
  #expect(b.people(on: "B1").isEmpty && b.taken.isEmpty)
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: "B1", selection: [])
  relay.run()
  #expect(b.people(on: "B1").map(\.name) == ["Cy"])
  clock.advance(31)
  b.tick()
  #expect(b.people(on: "B1").isEmpty)
}

@MainActor @Test func presenceRepeatsAndAHolderKeepsSendingLive() {
  let (relay, clock, a, _) = two()
  let me = relay.sockets[0].id
  func bodies() -> Int { relay.frames.filter { $0.from == me && $0.text.contains("\"body\"") }.count }
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let start = bodies()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 1)
  clock.advance(10)
  a.tick()
  relay.run()
  #expect(bodies() == start + 3)
  a.release()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 3)
}

@MainActor @Test func aReconnectAsksForItsHoldsAgain() {
  let (relay, clock, a, b) = two()
  var refused: Set<String> = []
  a.onRefused = { refused = $0 }
  a.hold(["c1"])
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  #expect(!a.connected && b.taken.isEmpty)
  #expect(a.mine == ["c1"])
  b.hold(["c1"])
  relay.run()
  clock.advance(1)
  relay.run()
  #expect(a.connected)
  #expect(refused == ["c1"])
}

@MainActor @Test func reconnectsBackOffAndStopForAWrongToken() {
  let relay = FakeRelay(), clock = Clock()
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

  let wrong = FakeRelay()
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
  let relay = FakeRelay(), clock = Clock()
  // the same secret, so the same token and key, but another space: its bodies do not open here
  let other = SpaceKeys(space: randomBytes(16), secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
  let stranger = live(relay, clock, keys: other)
  let b = live(relay, clock)
  stranger.connect()
  b.connect()
  relay.run()
  stranger.setPresence(board: "B1", selection: [])
  relay.run()
  #expect(stranger.connected && b.connected)
  #expect(b.people(on: "B1").isEmpty)
}

@MainActor @Test func aHolderWithNothingLiveYetStillKeepsItsHold() {
  let (relay, clock, a, _) = two()
  let me = relay.sockets[0].id
  func bodies() -> Int { relay.frames.filter { $0.from == me && $0.text.contains("\"body\"") }.count }
  a.hold(["c1"])
  relay.run()
  let start = bodies()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 1)
  a.release()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 1)
}

@MainActor @Test func theRelayGetsATokenMadeForIt() {
  let (relay, _, _, _) = two()
  #expect(relay.token == Base64URL.encode(keys().relayToken))
}

@MainActor @Test func connectingAgainWaitsForTheBackOff() {
  let relay = FakeRelay(), clock = Clock()
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
  let relay = FakeRelay(), clock = Clock()
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
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  a.close()
  relay.run()
  #expect(a.mine.isEmpty)
  a.connect()
  relay.run()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(a.connected && b.taken.isEmpty && b.overlay(on: "B1").isEmpty)
}

@MainActor @Test func whatThisDeviceHoldsIsNotOverlaid() {
  let (relay, _, a, b) = two()
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  a.sendPushed(7)
  a.release()
  relay.run()
  #expect(b.overlay(on: "B1") == moved)
  b.hold(["c1"])
  relay.run()
  #expect(b.overlay(on: "B1").isEmpty)
}

@MainActor @Test func cursorsAndLiveFieldsGoOnlyWhenSomeoneIsThere() {
  let relay = FakeRelay(), clock = Clock()
  let a = live(relay, clock)
  a.connect()
  relay.run()
  a.setPresence(board: "B1", selection: [])
  relay.run()
  let me = relay.sockets[0].id
  func bodies() -> Int { relay.frames.filter { $0.from == me && $0.text.contains("\"body\"") }.count }
  let start = bodies()
  a.sendCursor(board: "B1", x: 1, y: 1)
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  clock.advance(1)
  relay.run()
  #expect(bodies() == start)
  let b = live(relay, clock, name: "Bo")
  b.connect()
  relay.run()
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [1])
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(b.overlay(on: "B1") == moved)
}

@MainActor private func bodies(_ relay: FakeRelay, last n: Int) throws -> [[String: JSONValue]] {
  try relay.frames.filter { $0.text.contains("\"body\"") }.suffix(n).map { f in
    let m = try JSONDecoder().decode([String: JSONValue].self, from: Data(f.text.utf8))
    return try JSONDecoder().decode([String: JSONValue].self, from: keys().openLive(Base64URL.decode(m["body"]!.string!)!))
  }
}

@MainActor @Test func cursorsAndLiveEditsCarryTheSendersTimeAndASequenceNumber() throws {
  let (relay, clock, a, _) = two()
  a.sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  clock.advance(0.05)
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let b = try bodies(relay, last: 2)
  #expect(b.map { $0["t"]?.string } == ["cursor", "live"])
  #expect(b.map { $0["seq"]?.number } == [1, 2])
  #expect(abs(b[1]["at"]!.number! - b[0]["at"]!.number! - 50) < 0.001)
}

@MainActor @Test func cursorsPlayBackSmoothlyBetweenUpdates() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10, 20] {
    a.sendCursor(board: "B1", x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  clock.advance(-0.025)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [15])
  #expect(b.animating)
  clock.advance(0.1)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [20])
  #expect(!b.animating)
}

@MainActor @Test func aCursorOnAnotherBoardJumpsThere() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10] {
    a.sendCursor(board: "B1", x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  a.sendCursor(board: "B2", x: 500, y: 500)
  relay.run()
  #expect(b.cursors(on: "B2").map { [$0.cursor.x, $0.cursor.y] } == [[500, 500]])
}

@MainActor @Test func draggedPositionsPlayBackAndTextShowsOnArrival() {
  let (relay, clock, a, b) = two()
  a.hold(["c1"])
  for (x, text) in [(0.0, "a"), (10, "ab"), (20, "abc")] {
    a.sendLive(board: "B1", items: ["c1": ["pos": .array([.number(x), .number(0)]), "text": .string(text)]], caret: nil)
    relay.run()
    clock.advance(0.05)
  }
  clock.advance(-0.025)
  #expect(b.overlay(on: "B1")["c1"] == ["pos": .array([.number(15), .number(0)]), "text": .string("abc")])
}

@MainActor @Test func duplicatesAndLateBodiesAreDropped() {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: "B1", x: 5, y: 5)
  relay.run()
  let late = relay.frames.last!
  clock.advance(0.2)
  a.sendCursor(board: "B1", x: 9, y: 9)
  relay.run()
  relay.resend(late)
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [9])
}

@MainActor @Test func aSeqThatIsNotAnIntegerInRangeIsTreatedAsAbsent() throws {
  let (relay, clock, a, b) = two()
  let s = relay.sockets.first { $0.id == a.id }!
  for (i, seq) in [1e30, 1.5].enumerated() {
    let body: [String: JSONValue] = ["t": .string("cursor"), "board": .string("B1"), "x": .number(Double(i + 1)), "y": .number(0), "seq": .number(seq)]
    let sealed = try keys().sealLive(JSONEncoder().encode(JSONValue.object(body)))
    let frame = try JSONEncoder().encode(["body": Base64URL.encode(sealed)])
    relay.received(s, String(decoding: frame, as: UTF8.self))
    relay.run()
    clock.advance(0.2)
    #expect(b.cursors(on: "B1").map { $0.cursor.x } == [Double(i + 1)])
  }
}

/// `n` devices with fake transports, all on board B1, the last one the newcomer.
@MainActor private func direct(_ n: Int = 2) -> (FakeRelay, Clock, [FakePeerTransport], [Live]) {
  let relay = FakeRelay(), clock = Clock()
  var ts: [FakePeerTransport] = [], ls: [Live] = []
  for i in 0..<n {
    let t = FakePeerTransport()
    let l = Live(relay: "wss://relay.example/", space: space, keys: keys(), me: Person(device: newID(), name: "P\(i)"),
                 socket: { relay.connect($0) }, now: { clock.now }, uptime: { clock.now.timeIntervalSince1970 * 1000 },
                 schedule: { clock.schedule($0, $1) }, transport: t)
    l.connect()
    relay.run()
    l.setPresence(board: "B1", selection: [])
    relay.run()
    ts.append(t)
    ls.append(l)
  }
  return (relay, clock, ts, ls)
}

@MainActor private func open(_ ts: [FakePeerTransport], _ ls: [Live], _ i: Int, _ j: Int) {
  ts[i].onState?(ls[j].id!, .open)
  ts[j].onState?(ls[i].id!, .open)
}

@MainActor private func broadcasts(_ relay: FakeRelay) -> Int { relay.frames.filter { $0.text.contains("\"body\"") && !$0.text.contains("\"to\"") }.count }

@MainActor @Test func theNewcomerOffersThroughTheRelay() {
  let (_, _, ts, ls) = direct()
  #expect(Array(ts[1].log.prefix(2)) == ["create \(ls[0].id!)", "offer \(ls[0].id!)"])
  #expect(Array(ts[0].log.prefix(2)) == ["create \(ls[1].id!)", "answer \(ls[1].id!) offer-sdp \(ls[0].id!)"])
}

@MainActor @Test func withEveryChannelOpenCursorsGoOnlyDirect() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let before = broadcasts(relay)
  ls[0].sendCursor(board: "B1", x: 1, y: 1)
  clock.advance(Live.directSendInterval)
  ls[0].sendCursor(board: "B1", x: 2, y: 2)
  relay.run()
  #expect(broadcasts(relay) == before)
  #expect(ts[0].sent.count == 2)
  for s in ts[0].sent { ts[1].onMessage?(ls[0].id!, s.text) }
  clock.advance(0.2)
  #expect(ls[1].cursors(on: "B1").map { $0.cursor.x } == [2])
}

@MainActor @Test func withAChannelShortCursorsGoToTheRelayToo() {
  let (relay, _, ts, ls) = direct(3)
  open(ts, ls, 0, 1)
  let before = broadcasts(relay)
  ls[0].sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  #expect(broadcasts(relay) == before + 1)
  #expect(ts[0].sent.map(\.id) == [ls[1].id!])
}

@MainActor @Test func theHeartbeatGoesToTheRelayEvenWithEveryChannelOpen() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold(["c1"])
  ls[0].sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let before = broadcasts(relay)
  clock.advance(5)
  ls[0].tick()
  relay.run()
  #expect(broadcasts(relay) == before + 1)
}

@MainActor @Test func onlyCursorsAndLiveEditsAreTakenFromAChannel() throws {
  let (relay, _, ts, ls) = direct()
  open(ts, ls, 0, 1)
  var pushes: [Int] = []
  ls[1].onPushed = { pushes.append($0) }
  let sealed = Base64URL.encode(try keys().sealLive(Data(#"{"t":"pushed","version":9}"#.utf8)))
  ts[1].onMessage?(ls[0].id!, sealed)
  relay.run()
  #expect(pushes.isEmpty)
}

@MainActor @Test func aPeerLeavingClosesItsConnectionAndTheStatusCountsOpenChannels() {
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
