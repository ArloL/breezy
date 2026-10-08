import Testing
@testable import BreezyKit

@Test func edgeScrollingCrawlsThenSpeedsUpAsFreeformDoes() {
  #expect(EdgeScroll.speed(heldMs: 0) == 0.045)
  // Freeform scrolled 33 pt in the first half second and 96 pt by 0.8 s
  func scrolled(_ ms: Int) -> Double { (0..<ms).reduce(0) { $0 + EdgeScroll.speed(heldMs: Double($1)) } }
  #expect(abs(scrolled(500) - 33) < 8)
  #expect(abs(scrolled(800) - 96) < 15)
  #expect(EdgeScroll.speed(heldMs: 5000) == 1.5)
}

@Test func aSpringWithBounceOvershootsAndSettles() {
  let c = Spring.turn.curve()
  #expect(c.first == 0 && c.last == 1)
  #expect(c.max()! > 1.01)
  #expect(Spring.settle.curve().max()! <= 1.0001)
}

@Test func theCameraSpringSettlesInAboutHalfASecond() {
  let n = Double(Spring.camera.curve().count) / 120
  #expect(n > 0.3 && n < 0.8)
}
