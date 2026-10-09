import Foundation
import Testing
@testable import BreezyKit

private func live2() throws -> [String: JSONValue] {
  try JSONDecoder().decode(JSONValue.self, from: fixture("live2.json")).object!
}

private func ms(_ v: JSONValue?) -> Date { Date(timeIntervalSince1970: v!.number! / 1000) }

private func body(_ o: [String: JSONValue]) -> LiveBody {
  LiveBody(
    board: o["board"]!.string!,
    items: o["items"]!.object!.mapValues { $0.object! },
    starts: (o["starts"]?.object ?? [:]).mapValues { $0.array!.map { $0.number! } },
    caret: o["caret"]?.object.map { Caret(id: $0["id"]!.string!, back: $0["back"]!.bool!, at: Int($0["at"]!.number!)) },
    cursor: o["cursor"]?.array?.map { $0.number! })
}

private let b1 = "YGFiY2RlZmdoaWprbG1ubw", a = "AQEBAQEBAQEBAQEBAQEBAQ"

private func valid(_ x: Double) -> LiveBody {
  LiveBody(board: b1, items: [a: ["pos": .array([.number(x), .number(0)]), "kind": .string("card")]],
           caret: Caret(id: a, back: false, at: 0))
}

@Suite struct CompactTests {
  @Test func fnv1aHashesUTF16CodeUnits() throws {
    for p in try live2()["fnv1a"]!.array! {
      let t = p.array![0].string!
      #expect(Compact.fnv1a(t) == UInt32(p.array![1].number!), Comment(rawValue: t))
    }
  }

  @Test func spliceKeepsTheCommonPrefixAndSuffixWhole() throws {
    for p in try live2()["splice"]!.array! {
      let a = p.array!, want = a[2].array!
      let s = Compact.splice(a[0].string!, a[1].string!)
      #expect([s.at, s.del] == [Int(want[0].number!), Int(want[1].number!)] && s.ins == want[2].string!,
              Comment(rawValue: "\(a[0].string!) → \(a[1].string!)"))
    }
  }

  @Test func live2Cases() throws {
    for c in try live2()["cases"]!.array!.map({ $0.object! }) {
      let name = c["name"]!.string!, steps = c["steps"]!.array!.map { $0.object! }
      let cursor = CursorEncoder(), live = LiveEncoder(), decoder = LiveDecoder()
      var overlay: [String: LiveFields] = [:]
      for (i, s) in steps.enumerated() {
        let at = Comment(rawValue: "\(name) step \(i)")
        let wire: Data
        if let r = s["redeliver"]?.number {
          wire = bytes(steps[Int(r)]["hex"]!.string!)
        } else if let r = s["receive"]?.string {
          wire = bytes(r)
        } else {
          let seq = Int(s["seq"]!.number!), t = s["at"]!.number!, now = ms(s["now"])
          if let o = s["cursor"]?.object {
            if s["reset"]?.bool == true { cursor.reset() }
            wire = try cursor.encode(seq: seq, at: t, x: o["x"]?.number, y: o["y"]?.number, board: o["board"]!.string!, now: now)
          } else {
            if s["reset"]?.bool == true { live.reset() }
            wire = try live.encode(body(s["live"]!.object!), seq: seq, at: t, now: now)
          }
          #expect(hex(wire) == s["hex"]!.string!, at)
          #expect(Compact.isCompact(wire), at)
        }
        if s["lost"]?.bool == true { continue }
        if let o = s["overlay"]?.object { overlay = o.mapValues { $0.object! } }
        let got = decoder.decode(wire, overlay: overlay)
        #expect((got.map(JSONValue.object) ?? .null) == s["decoded"]!, at)
        for (id, f) in got?["items"]?.object ?? [:] { overlay[id, default: [:]].merge(f.object!) { $1 } }
      }
    }
  }

  @Test func malformedBodiesDecodeToNil() throws {
    for m in try live2()["malformed"]!.array!.map({ $0.object! }) {
      #expect(LiveDecoder().decode(bytes(m["hex"]!.string!)) == nil, Comment(rawValue: m["name"]!.string!))
    }
  }

  @Test func anEncoderThatThrowsIsLeftAsItWas() throws {
    let t0 = Date(timeIntervalSince1970: 0), t1 = Date(timeIntervalSince1970: 1)
    var bad = [valid(1), valid(1), valid(1), valid(1), valid(1)]
    bad[0].board = "short"
    bad[1].items = ["short": ["pos": .array([.number(1), .number(0)])]]
    bad[2].items = [a: ["kind": .string("note")]]
    bad[3].caret = Caret(id: "short", back: false, at: 0)
    // beyond MessagePack's safe integers, so packing throws after the body is built
    bad[4].items[a]!["color"] = .number(0x1p60)
    for b in bad {
      let enc = LiveEncoder(), ref = LiveEncoder()
      for e in [enc, ref] { _ = try e.encode(valid(0), seq: 1, at: 0, now: t0) }
      #expect(throws: (any Error).self) { try enc.encode(b, seq: 2, at: 1, now: t1) }
      #expect(try enc.encode(valid(1), seq: 2, at: 1, now: t1) == ref.encode(valid(1), seq: 2, at: 1, now: t1))
    }
    let enc = CursorEncoder(), ref = CursorEncoder()
    for e in [enc, ref] { _ = try e.encode(seq: 1, at: 0, x: 1, y: 1, board: b1, now: t0) }
    #expect(throws: Compact.Failure.self) { try enc.encode(seq: 2, at: 1, x: 1, y: 1, board: "short", now: t1) }
    #expect(try enc.encode(seq: 2, at: 1, x: 1, y: 1, board: b1, now: t1) == ref.encode(seq: 2, at: 1, x: 1, y: 1, board: b1, now: t1))
  }

  @Test func aSpliceThatSplitsASurrogatePairIsNotApplied() throws {
    let id = Base64URL.decode(a)!, board = Base64URL.decode(b1)!
    let splice = Pack.array([.int(Int64(Compact.fnv1a("😀"))), .int(1), .int(0), .string("x")])
    let wire = try Pack.array([.int(2), .int(1), .int(1), .bin(board), .null, .map([(.bin(id), .map([(.int(3), splice)]))]), .null, .null]).packed()
    let got = LiveDecoder().decode(wire, overlay: [a: ["text": .string("😀")]])
    #expect(got?["items"] == .object([:]))
  }

  @Test func isCompactTellsArraysFromOtherBytes() {
    #expect(Compact.isCompact(bytes("9101")))
    #expect(Compact.isCompact(bytes("dc0000")))
    #expect(!Compact.isCompact(bytes("7b")))
    #expect(!Compact.isCompact(Data()))
  }

  @Test func fieldsAreKeyedByTheirIndex() {
    #expect(Compact.fields == ["pos", "size", "w", "text", "notes", "color", "title", "kind"])
    #expect(Compact.keyframe == 1)
  }
}
