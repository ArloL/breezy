// Posts one of the owner's reference strokes into the front app as fresh events made from its recorded ones, at their
// times, each moved by dx, dy and the cursor warped to it first, as a pinch zooms about the cursor: a scroll's point
// deltas and phases, a gesture's type, magnification and phase. The recorded events posted as they are reach nothing
// in Firefox, even with their window and process cleared (the spike in
// docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md). Needs Accessibility for the posting app.
//   swiftc -O scripts/post-stroke.swift -o build/post-stroke && build/post-stroke <stroke.json> <dx> <dy>
import Foundation
import CoreGraphics
let a = CommandLine.arguments
let s = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[1]))) as! [String: Any]
let dx = Double(a[2])!, dy = Double(a[3])!
let raw = s["raw"] as! [[String]]
let t0 = Date()
var posted = 0, kinds: [String: Int] = [:], magnified = 0.0
func field(_ n: UInt32) -> CGEventField { CGEventField(rawValue: n)! }
for r in raw {
  let t = Double(r[0])! / 1000
  guard let data = Data(base64Encoded: r[1]), let e = CGEvent(withDataAllocator: nil, data: data as CFData) else { continue }
  let at = CGPoint(x: e.location.x + dx, y: e.location.y + dy)
  var out: CGEvent?
  switch e.type.rawValue {
  case 22:
    let f = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                    wheel1: Int32(e.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)), wheel2: Int32(e.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)), wheel3: 0)!
    f.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    f.setIntegerValueField(.scrollWheelEventScrollPhase, value: e.getIntegerValueField(.scrollWheelEventScrollPhase))
    f.setIntegerValueField(.scrollWheelEventMomentumPhase, value: e.getIntegerValueField(.scrollWheelEventMomentumPhase))
    out = f; kinds["scroll", default: 0] += 1
  case 29:
    let f = CGEvent(source: nil)!
    f.type = CGEventType(rawValue: 29)!
    for n: UInt32 in [110, 132] { f.setIntegerValueField(field(n), value: e.getIntegerValueField(field(n))) }
    f.setDoubleValueField(field(113), value: e.getDoubleValueField(field(113)))
    magnified += e.getDoubleValueField(field(113))
    out = f; kinds["gesture \(e.getIntegerValueField(field(110)))", default: 0] += 1
  default: kinds["other \(e.type.rawValue)", default: 0] += 1
  }
  guard let out else { continue }
  let wait = t - Date().timeIntervalSince(t0)
  if wait > 0 { Thread.sleep(forTimeInterval: wait) }
  out.location = at
  CGWarpMouseCursorPosition(at)
  out.post(tap: .cghidEventTap)
  posted += 1
}
print("posted \(posted) of \(raw.count): \(kinds.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")), magnification \(magnified)")
