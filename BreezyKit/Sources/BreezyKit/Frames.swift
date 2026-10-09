import Foundation

/// Binary frames between a device and the relay, as relay/src/frames.js has them byte for byte.
/// Device to relay: 0x00 body (to everyone else), 0x01 leb(to) body (to one). Relay to device: leb(from) body.
public enum Frames {
  static let maxLebBytes = 5

  /// Unsigned LEB128, low group first.
  public static func leb(_ n: Int) -> Data {
    var out = Data(), n = n
    while n >= 0x80 {
      out.append(UInt8(n & 0x7f | 0x80))
      n >>= 7
    }
    out.append(UInt8(n))
    return out
  }

  /// The LEB128 at offset `i` from the start; nil if truncated, over 5 bytes or above 2^32.
  public static func readLeb(_ bytes: Data, _ i: Int) -> (value: Int, next: Int)? {
    let b = [UInt8](bytes)
    var value = 0
    for k in 0..<maxLebBytes {
      guard i + k < b.count else { return nil }
      value += Int(b[i + k] & 0x7f) << (7 * k)
      if b[i + k] & 0x80 == 0 { return value > 1 << 32 ? nil : (value, i + k + 1) }
    }
    return nil
  }

  /// The frame that sends `body` to connection number `to`, or to everyone else when nil.
  public static func relayFrame(to: Int?, _ body: Data) -> Data {
    (to.map { Data([1]) + leb($0) } ?? Data([0])) + body
  }

  /// The sender's number and the body from a frame the relay forwarded; nil if malformed.
  public static func parseRelayFrame(_ bytes: Data) -> (from: Int, body: Data)? {
    let d = Data(bytes)
    guard let r = readLeb(d, 0) else { return nil }
    return (r.value, d.subdata(in: r.next..<d.count))
  }
}
