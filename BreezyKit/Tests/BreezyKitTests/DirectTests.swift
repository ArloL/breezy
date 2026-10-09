import Foundation
import Testing
@testable import BreezyKit

@MainActor private final class Rig {
  var now = Date(timeIntervalSince1970: 1_000_000)
  let transport = FakePeerTransport()
  var relayed: [[String: JSONValue]] = []
  var messages: [(String, String)] = []
  var changes = 0
  lazy var direct = Direct(
    transport: transport, now: { [unowned self] in now },
    relay: { [unowned self] to, b in relayed.append(b.merging(["to": .string(to)]) { $1 }) },
    message: { [unowned self] in messages.append(($0, $1)) }, change: { [unowned self] in changes += 1 })
  func tag(_ b: [String: JSONValue]) -> String { "\(b["t"]!.string!) \(b["to"]!.string!)" }
}

private let c1 = IceCandidate(candidate: "c1", mid: "0", index: 0)
private let ice: [String: JSONValue] = ["t": .string("ice"), "candidate": .string("c1"), "mid": .string("0"), "index": .number(0)]

@MainActor @Test func theNewcomerOffersToEveryoneItsCandidatesAfterItsOffer() {
  let r = Rig()
  r.transport.onOffer = [c1]
  r.direct.welcome(["p1", "p2"])
  #expect(r.transport.log == ["create p1", "offer p1", "create p2", "offer p2"])
  #expect(r.relayed.map(r.tag) == ["offer p1", "ice p1", "offer p2", "ice p2"])
  #expect(r.relayed[1] == ice.merging(["to": .string("p1")]) { $1 })
}

@MainActor @Test func anOfferIsAnsweredAndEarlyCandidatesWait() {
  let r = Rig()
  r.transport.deferred = true
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.direct.heard("p1", ice)
  #expect(r.transport.log == ["create p1", "answer p1 o"])
  r.transport.release()
  #expect(r.transport.log == ["create p1", "answer p1 o", "add p1 c1"])
  #expect(r.relayed == [["t": .string("answer"), "sdp": .string("answer-sdp p1"), "to": .string("p1")]])
}

@MainActor @Test func anAnswerIsAcceptedThenEarlyCandidatesAdded() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.deferred = true
  r.direct.heard("p1", ice)
  r.direct.heard("p1", ["t": .string("answer"), "sdp": .string("a")])
  r.transport.release()
  #expect(r.transport.log == ["create p1", "offer p1", "accept p1 a", "add p1 c1"])
}

@MainActor @Test func anOfferToAConnectionThatOfferedIsIgnored() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  #expect(r.transport.log == ["create p1", "offer p1"])
}

@MainActor @Test func openChannelsCarryMessages() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.onMessage?("p1", "early")
  r.transport.onState?("p1", .open)
  #expect(r.direct.isOpen("p1") && r.changes == 1)
  r.transport.onMessage?("p1", "hello")
  #expect(r.messages.map(\.1) == ["hello"])
  #expect(r.direct.send("p1", "x") && !r.direct.send("p2", "x"))
}

@MainActor @Test func aChannelThatDoesNotOpenIn10sIsGivenUp() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.now += Direct.openTimeout - 0.001
  r.direct.tick()
  #expect(!r.transport.log.contains("close p1"))
  r.now += 0.001
  r.direct.tick()
  #expect(r.transport.log.contains("close p1"))
}

@MainActor @Test func theOffererRestartsUpToThreeTimes() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.onState?("p1", .open)
  for _ in 0..<4 {
    r.transport.onState?("p1", .failed)
    r.now += Direct.restartDelay
    r.direct.tick()
  }
  #expect(r.transport.log.filter { $0 == "offer p1 restart" }.count == 3)
}

@MainActor @Test func theAnswererWaitsForTheOffererToRestart() {
  let r = Rig()
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.transport.onState?("p1", .open)
  r.transport.onState?("p1", .failed)
  r.now += Direct.restartDelay
  r.direct.tick()
  #expect(!r.transport.log.contains { $0.hasPrefix("offer") } && !r.transport.log.contains("close p1"))
}

@MainActor @Test func leaveAndResetClose() {
  let r = Rig()
  r.direct.welcome(["p1", "p2"])
  r.direct.leave("p1")
  r.direct.reset()
  #expect(r.transport.log.filter { $0.hasPrefix("close") } == ["close p1", "close p2"])
}

@MainActor @Test func aSecondOfferWhileAnAnswerIsInFlightIsIgnored() {
  let r = Rig()
  r.transport.deferred = true
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.transport.release()
  #expect(r.transport.log == ["create p1", "answer p1 o"])
  #expect(r.relayed == [["t": .string("answer"), "sdp": .string("answer-sdp p1"), "to": .string("p1")]])
}

@MainActor @Test func aFailedAcceptClosesTheConnection() {
  let r = Rig()
  r.transport.fail = ["accept"]
  r.direct.welcome(["p1"])
  r.direct.heard("p1", ["t": .string("answer"), "sdp": .string("a")])
  #expect(r.transport.log.contains("close p1"))
  #expect(!r.direct.isOpen("p1"))
}
