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

@Test func anEmptyTrackIsNotPlaying() {
  #expect(!Track().playing(0))
}

@Test func aSampleAtTheSameTimeAsTheLastIsDropped() {
  var t = Track()
  t.push(at: 0, arrival: 0, value: [0])
  t.push(at: 0, arrival: 10, value: [5])
  #expect(t.sample(1000) == [0])
}

@Test func aSampleLateWithoutAPauseIsMovedTowardsRatherThanHeldFor() {
  var t = Track()
  for at in [0.0, 16, 32] { t.push(at: at, arrival: 1000 + at, value: [0]) }
  t.push(at: 100, arrival: 1100, value: [68])
  #expect(t.delay == 16)
  #expect(t.sample(1082) == [34])
}
