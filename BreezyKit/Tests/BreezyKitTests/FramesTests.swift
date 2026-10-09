import Foundation
import Testing
@testable import BreezyKit

/// LEB128 of each number as relay/src/frames.js writes it.
private let lebs: [(Int, String)] = [
  (0, "00"), (1, "01"), (127, "7f"), (128, "8001"), (300, "ac02"), (16383, "ff7f"), (16384, "808001"),
  (1 << 31, "8080808008"), (1 << 32 - 1, "ffffffff0f"), (1 << 32, "8080808010"),
]

@Test func lebAndReadLebMatchTheRelaysByteForByte() {
  for (n, h) in lebs {
    #expect(hex(Frames.leb(n)) == h)
    let r = Frames.readLeb(bytes(h), 0)
    #expect(r?.value == n && r?.next == h.count / 2)
  }
  for bad in ["80", "", "808080808001", "ffffffff7f"] { #expect(Frames.readLeb(bytes(bad), 0) == nil) }
}

@Test func theRelayReadsTheFramesADeviceSendsAndADeviceReadsTheFramesTheRelayForwards() {
  let body = Data([7, 8, 9])
  #expect(hex(Frames.relayFrame(to: nil, body)) == "00070809")
  for (n, h) in lebs.dropLast() {
    #expect(hex(Frames.relayFrame(to: n, body)) == "01\(h)070809")
    let f = Frames.parseRelayFrame(bytes(h + "070809"))
    #expect(f?.from == n && f?.body == body)
  }
  #expect(hex(Frames.relayFrame(to: 300, body)) == "01ac02070809")
  let lone = Frames.parseRelayFrame(Data([5]))
  #expect(lone?.from == 5 && lone?.body == Data())
  #expect(Frames.parseRelayFrame(Data()) == nil)
  #expect(Frames.parseRelayFrame(Data([0x80])) == nil)
  // a slice's indices do not start at 0
  let f = Frames.parseRelayFrame(bytes("ff01ac02070809").dropFirst(2))
  #expect(f?.from == 300 && f?.body == body)
}
