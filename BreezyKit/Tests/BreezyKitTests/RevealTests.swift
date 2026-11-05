import Foundation
import Testing
@testable import BreezyKit

@Test func aRectTooTallShowsItsTopUnlessAskedForItsBottom() {
  let tall = Rect(x: 16, y: 300, w: 370, h: 600), area = Rect(x: 0, y: 120, w: 402, h: 418)
  #expect(tall.revealShift(in: area).dy == tall.revealShift(in: area, bottom: false).dy)
  #expect(tall.revealShift(in: area).dy != tall.revealShift(in: area, bottom: true).dy)
}

@Test func revealShiftsAsTheWebDoes() throws {
  let cases = try #require(try JSONSerialization.jsonObject(with: fixture("reveal.json")) as? [String: Any])["cases"] as! [[String: Any]]
  for c in cases {
    let n = { (k: String) in (c[k] as! [NSNumber]).map(\.doubleValue) }
    let a = n("area"), r = n("rect"), shift = n("shift")
    let s = Rect(x: r[0], y: r[1], w: r[2], h: r[3])
      .revealShift(in: Rect(x: a[0], y: a[1], w: a[2] - a[0], h: a[3] - a[1]), pad: (c["pad"] as! NSNumber).doubleValue, bottom: c["prefer"] as! String == "bottom")
    #expect([s.dx, s.dy] == shift, "\(c["name"]!)")
  }
}
