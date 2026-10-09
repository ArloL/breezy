import Foundation
import Testing
@testable import BreezyKit

private let space = "QEFCQ0RFRkdISUpLTE1OTw"

private func keys() -> SpaceKeys {
  SpaceKeys(space: Base64URL.decode(space)!, secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
}

@MainActor private func live(_ relay: FakeRelay, _ clock: Clock, name: String = "Ana", device: String = newID(), keys k: SpaceKeys = keys()) -> Live {
  Live(relay: "wss://relay.example/", space: space, keys: k, me: Person(device: device, name: name),
       socket: { relay.connect($0) }, now: { clock.now }, schedule: { clock.schedule($0, $1) })
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
