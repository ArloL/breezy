import Foundation
import Testing
@testable import BreezyKit

@Test func tracksPlayBackAsTheWebDoes() throws {
  let cases = try #require(try JSONSerialization.jsonObject(with: fixture("track.json")) as? [String: Any])["cases"] as! [[String: Any]]
  for c in cases {
    let name = c["name"] as! String
    var t = Track()
    for s in c["samples"] as! [[Any]] {
      t.push(at: (s[0] as! NSNumber).doubleValue, arrival: (s[1] as! NSNumber).doubleValue, value: (s[2] as! [NSNumber]).map(\.doubleValue))
    }
    #expect(t.delay == (c["delay"] as! NSNumber).doubleValue, "\(name)")
    for q in c["queries"] as! [[Any]] {
      #expect(t.sample((q[0] as! NSNumber).doubleValue) == (q[1] as! [NSNumber]).map(\.doubleValue), "\(name) at \(q[0])")
    }
    for q in c["playing"] as? [[Any]] ?? [] {
      #expect(t.playing((q[0] as! NSNumber).doubleValue) == (q[1] as! Bool), "\(name) playing at \(q[0])")
    }
  }
}
