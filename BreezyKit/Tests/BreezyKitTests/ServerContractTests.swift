import Foundation
import Testing
@testable import BreezyKit

/// FakeServer held to sync.php: the calls server/test/contract.test.mjs played against it, and its answers, which it
/// writes to BREEZY_CONTRACT (web/test/helpers/server-contract.ts). Runs only from server/test.sh, after it.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["BREEZY_CONTRACT"] != nil))
struct ServerContractTests {
  struct Step: Decodable {
    let op: String
    let since: Int?
    let writes: [Write]?
    /// "current", "previous" or "unknown"
    let epoch: String?
  }

  struct Run: Decodable {
    let seed: Int
    let steps: [Entry]
  }

  struct Entry: Decodable {
    let step: Step
    let answer: JSONValue
  }

  /// An answer as the contract compares it: epochs named E0, E1, … in the order they came, `stale` only when true.
  struct Normal: Encodable {
    struct Rec: Encodable {
      let id: String, version: Int, blob: String, stale: Bool?
      init(_ p: Pulled) { (id, version, blob, stale) = (p.id, p.version, p.blob, p.stale == true ? true : nil) }
    }

    var accepted: [Accepted]?, refused: [Rec]?, epoch: String?, cursor: Int?, records: [Rec]?, relay: String?

    func encode(to encoder: Encoder) throws {
      enum K: CodingKey { case accepted, refused, epoch, cursor, records, relay }
      var c = encoder.container(keyedBy: K.self)
      try c.encodeIfPresent(accepted, forKey: .accepted)
      try c.encodeIfPresent(refused, forKey: .refused)
      try c.encode(epoch, forKey: .epoch)
      try c.encodeIfPresent(cursor, forKey: .cursor)
      try c.encodeIfPresent(records, forKey: .records)
      try c.encodeIfPresent(relay, forKey: .relay)
    }
  }

  /// Plays steps on a FakeServer as one device would, as the web's Player does.
  struct Player {
    let server = FakeServer()
    var names: [String: String] = [:]
    /// The epochs seen, newest last.
    var seen: [String] = []

    mutating func play(_ s: Step) throws -> JSONValue {
      switch s.op {
      case "restore":
        server.restore(server.snapshot())
        return .null
      case "wipe":
        server.wipe()
        return .null
      case "pull":
        let p = server.pull(since: s.since!)
        saw(p.epoch)
        return try json(Normal(epoch: name(p.epoch), cursor: p.cursor, records: p.records.map(Normal.Rec.init), relay: p.relay))
      default:
        let want: String? = switch s.epoch {
        case "unknown": "AAAAAAAAAAAAAAAAAAAAAA"
        case "current": seen.last
        case "previous": seen.count > 1 ? seen[seen.count - 2] : nil
        default: nil
        }
        let r = server.push(s.writes!, since: s.since, epoch: want)
        saw(r.epoch)
        return try json(Normal(accepted: r.accepted, refused: r.refused.map(Normal.Rec.init), epoch: name(r.epoch), cursor: r.cursor,
                               records: r.records?.map(Normal.Rec.init), relay: r.relay))
      }
    }

    private mutating func saw(_ epoch: String?) {
      if let epoch, seen.last != epoch { seen.append(epoch) }
    }

    private mutating func name(_ epoch: String?) -> String? {
      guard let epoch else { return nil }
      if names[epoch] == nil { names[epoch] = "E\(names.count)" }
      return names[epoch]
    }

    private func json(_ n: Normal) throws -> JSONValue {
      try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(n))
    }
  }

  @Test func theFakeServerAnswersAsSyncPhpDoes() throws {
    let file = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BREEZY_CONTRACT"]!)
    let runs = try JSONDecoder().decode([Run].self, from: Data(contentsOf: file))
    #expect(!runs.isEmpty)
    for run in runs {
      var player = Player()
      for (i, entry) in run.steps.enumerated() {
        let got = try player.play(entry.step)
        // the first difference of a run, as each after it follows from it
        guard got == entry.answer else {
          Issue.record("seed \(run.seed), step \(i) (\(entry.step.op)): the fake answered \(got), sync.php \(entry.answer)")
          break
        }
      }
    }
  }
}
