import BreezyKit
import Foundation

/// Direct channels through the hub, one to one with `PeerTransport`. `offer`, `answer` and `accept` finish when the hub
/// sends `peer-done` with their `call`.
@MainActor final class SimPeer: PeerTransport {
  private weak var device: SimDevice?
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, PeerMessage) -> Void)?
  private var open: Set<String> = []

  init(device: SimDevice) { self.device = device }

  private func emit(_ ev: String, _ peer: String, _ fields: Fields = [:]) {
    device?.emit(ev, fields.merging(["peer": .string(peer)]) { a, _ in a })
  }

  private func call(_ done: @escaping @MainActor (JSONValue) -> Void) -> JSONValue {
    .int(device?.call(done) ?? 0)
  }

  func create(_ peer: String) {
    device?.peers[peer] = self
    emit("peer-create", peer)
  }

  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void) {
    emit("peer-offer", peer, ["restart": .bool(restart), "call": call { done($0.string) }])
  }

  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void) {
    emit("peer-answer", peer, ["sdp": .string(offer), "call": call { done($0.string) }])
  }

  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void) {
    emit("peer-accept", peer, ["sdp": .string(answer), "call": call { done($0.bool ?? false) }])
  }

  func add(_ peer: String, candidate: IceCandidate) {
    emit("peer-add", peer, ["candidate": Self.json(candidate)])
  }

  func send(_ peer: String, _ text: String) -> Bool {
    guard open.contains(peer) else { return false }
    emit("peer-send", peer, ["text": .string(text)])
    return true
  }

  func sendBytes(_ peer: String, _ data: Data) -> Bool {
    guard open.contains(peer) else { return false }
    emit("peer-send", peer, ["bytes": .bytes(data)])
    return true
  }

  func close(_ peer: String) {
    open.remove(peer)
    if device?.peers[peer] === self { device?.peers[peer] = nil }
    emit("peer-close", peer)
  }

  /// A `peer-state`, `peer-msg` or `peer-candidate` from the hub.
  func heard(_ cmd: String, _ peer: String, _ c: JSONValue) throws {
    switch cmd {
    case "peer-state":
      guard let state = PeerState(rawValue: try c.string("state")) else { throw SimError("state must be open, closed or failed") }
      if state == .open { open.insert(peer) } else { open.remove(peer) }
      onState?(peer, state)
    case "peer-msg": onMessage?(peer, try c.message())
    default:
      let candidate = try c["candidate"]?.object.map { o in
        IceCandidate(candidate: try JSONValue.object(o).string("candidate"), mid: o["mid"]?.string, index: o["index"]?.int)
      }
      onCandidate?(peer, candidate)
    }
  }

  static func json(_ c: IceCandidate) -> JSONValue {
    .object(["candidate": .string(c.candidate), "mid": .optional(c.mid), "index": c.index.map { .int($0) } ?? .null])
  }
}
