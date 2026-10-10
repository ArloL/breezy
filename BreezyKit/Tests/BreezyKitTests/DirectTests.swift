import Foundation
import Testing
@testable import BreezyKit

@MainActor private final class Rig {
  var now = Date(timeIntervalSince1970: 1_000_000)
  let transport = FakePeerTransport()
  var relayed: [[String: JSONValue]] = []
  var messages: [(String, PeerMessage)] = []
  var changes = 0
  var lost = 0
  lazy var direct = Direct(
    transport: transport, now: { [unowned self] in now },
    relay: { [unowned self] to, b in relayed.append(b.merging(["to": .string(to)]) { $1 }) },
    message: { [unowned self] in messages.append(($0, $1)) }, change: { [unowned self] in changes += 1 },
    lost: { [unowned self] in lost += 1 })
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
  #expect(r.relayed == [["t": .string("answer"), "sdp": .string("answer-sdp p1"), "v": .number(2), "to": .string("p1")]])
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
  r.transport.onMessage?("p1", .text("early"))
  r.transport.onState?("p1", .open)
  #expect(r.direct.isOpen("p1") && r.changes == 1)
  r.transport.onMessage?("p1", .text("hello"))
  #expect(r.messages.map(\.1) == [.text("hello")])
  #expect(r.direct.send("p1", "x") && !r.direct.send("p2", "x"))
}

@MainActor @Test func offersAndAnswersSayVersion2AndALinkIs2OnlyWhenTheOtherSideSaidSo() {
  func offerer(_ answer: [String: JSONValue]) -> Int {
    let r = Rig()
    r.direct.welcome(["p1"])
    #expect(r.relayed == [["t": .string("offer"), "sdp": .string("offer-sdp p1"), "v": .number(2), "to": .string("p1")]])
    #expect(r.direct.version("p1") == 1)
    r.direct.heard("p1", answer)
    return r.direct.version("p1")
  }
  #expect(offerer(["t": .string("answer"), "sdp": .string("a"), "v": .number(2)]) == 2)
  #expect(offerer(["t": .string("answer"), "sdp": .string("a")]) == 1)
  func answerer(_ offer: [String: JSONValue]) -> Int {
    let r = Rig()
    r.direct.heard("p1", offer)
    #expect(r.relayed.first?["v"] == .number(2))
    return r.direct.version("p1")
  }
  #expect(answerer(["t": .string("offer"), "sdp": .string("o"), "v": .number(2)]) == 2)
  #expect(answerer(["t": .string("offer"), "sdp": .string("o")]) == 1)
  #expect(Rig().direct.version("p9") == 1)
}

@MainActor @Test func aVersion2LinkCarriesOnlyBytesAVersion1LinkOnlyText() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.direct.heard("p2", ["t": .string("offer"), "sdp": .string("o"), "v": .number(2)])
  r.transport.onState?("p1", .open)
  r.transport.onState?("p2", .open)
  let bytes = Data([1, 2])
  r.transport.onMessage?("p1", .bytes(bytes))
  r.transport.onMessage?("p1", .text("one"))
  r.transport.onMessage?("p2", .text("two"))
  r.transport.onMessage?("p2", .bytes(bytes))
  #expect(r.messages.map(\.0) == ["p1", "p2"])
  #expect(r.messages.map(\.1) == [.text("one"), .bytes(bytes)])
  #expect(r.direct.sendBytes("p2", bytes) && !r.direct.sendBytes("p3", bytes))
  #expect(r.transport.sent.map(\.id) == ["p2"] && r.transport.sent.map(\.message) == [.bytes(bytes)])
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
  #expect(r.relayed == [["t": .string("answer"), "sdp": .string("answer-sdp p1"), "v": .number(2), "to": .string("p1")]])
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o2")])
  #expect(r.transport.log.last == "answer p1 o2")
}

@MainActor @Test func aFailedAcceptClosesTheConnection() {
  let r = Rig()
  r.transport.fail = ["accept"]
  r.direct.welcome(["p1"])
  r.direct.heard("p1", ["t": .string("answer"), "sdp": .string("a")])
  #expect(r.transport.log.contains("close p1"))
  #expect(!r.direct.isOpen("p1"))
}

@MainActor @Test func aFailedOfferClosesTheConnection() {
  let r = Rig()
  r.transport.fail = ["offer"]
  r.direct.welcome(["p1"])
  #expect(r.transport.log.contains("close p1"))
  #expect(r.relayed.isEmpty)
}

@MainActor @Test func aFailedAnswerClosesTheConnection() {
  let r = Rig()
  r.transport.fail = ["answer"]
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  #expect(r.transport.log.contains("close p1"))
  #expect(r.relayed.isEmpty)
}

@MainActor @Test func aCandidateIndexThatIsNotAnIntegerIsDropped() {
  let r = Rig()
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  for index in [1e300, 1.5, .infinity] {
    r.direct.heard("p1", ice.merging(["index": .number(index)]) { $1 })
  }
  r.direct.heard("p1", ice.merging(["index": .number(2)]) { $1 })
  #expect(r.transport.added.map(\.index) == [nil, nil, nil, 2])
}

/// A version 2 channel to p1 that is open and has beaten once; this side offered unless `answerer`.
@MainActor private func beating(answerer: Bool = false) -> Rig {
  let r = Rig()
  if answerer {
    r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o"), "v": .number(2)])
  } else {
    r.direct.welcome(["p1"])
    r.direct.heard("p1", ["t": .string("answer"), "sdp": .string("a"), "v": .number(2)])
  }
  r.transport.onState?("p1", .open)
  r.transport.onMessage?("p1", .bytes(Direct.beat))
  return r
}

@MainActor @Test func eachTickBeatsOverEveryOpenVersion2ChannelAndABeatIsNoMessage() {
  let r = beating()
  r.direct.heard("p2", ["t": .string("offer"), "sdp": .string("o")])
  r.transport.onState?("p2", .open)
  r.direct.tick()
  #expect(r.transport.sent.map(\.id) == ["p1"] && r.transport.sent.map(\.message) == [.bytes(Direct.beat)])
  #expect(r.messages.isEmpty)
}

@MainActor @Test func aChannelSilentAfterABeatClosesAndItsOffererRestartsAtOnce() {
  let r = beating()
  r.now += Direct.silence - 0.001
  r.direct.tick()
  #expect(r.direct.isOpen("p1"))
  r.now += 0.001
  r.direct.tick()
  #expect(!r.direct.isOpen("p1") && r.changes == 2)
  #expect(r.transport.log.contains("offer p1 restart"))
}

@MainActor @Test func aSilentChannelsAnswererClosesItAndWaitsForTheOfferer() {
  let r = beating(answerer: true)
  r.now += Direct.silence
  r.direct.tick()
  #expect(!r.direct.isOpen("p1"))
  #expect(!r.transport.log.contains { $0.hasPrefix("offer") })
}

@MainActor @Test func anyMessageKeepsAChannelOpen() {
  let r = beating()
  for _ in 0..<5 {
    r.now += Direct.silence - 0.001
    r.transport.onMessage?("p1", .bytes(Data([0x90])))
    r.direct.tick()
  }
  #expect(r.direct.isOpen("p1"))
}

@MainActor @Test func aChannelThatNeverBeatIsNotClosedForSilence() {
  let r = Rig()
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o"), "v": .number(2)])
  r.transport.onState?("p1", .open)
  r.now += Direct.openTimeout
  r.direct.tick()
  #expect(r.direct.isOpen("p1"))
}

@MainActor @Test func aChannelClosedForSilenceOpensAgainWhenHeard() {
  let r = beating(answerer: true)
  r.now += Direct.silence
  r.direct.tick()
  let bytes = Data([0x90])
  r.transport.onMessage?("p1", .bytes(bytes))
  #expect(r.direct.isOpen("p1") && r.changes == 3)
  #expect(r.messages.map(\.1) == [.bytes(bytes)])
}

@MainActor @Test func aChannelClosedForSilenceStillBeats() {
  let r = beating(answerer: true)
  r.now += Direct.silence
  r.direct.tick()
  r.transport.sent = []
  r.direct.tick()
  #expect(r.transport.sent.map(\.message) == [.bytes(Direct.beat)])
}

@MainActor @Test func aChannelThatFailsOrFallsSilentIsLostAndOneLeftIsNot() {
  let r = beating()
  r.transport.onState?("p1", .failed)
  #expect(r.lost == 1)
  r.transport.onState?("p1", .open)
  r.transport.onMessage?("p1", .bytes(Direct.beat))
  r.now += Direct.silence
  r.direct.tick()
  #expect(r.lost == 2)
  r.transport.onMessage?("p1", .bytes(Direct.beat))
  r.direct.leave("p1")
  #expect(r.lost == 2)
}
