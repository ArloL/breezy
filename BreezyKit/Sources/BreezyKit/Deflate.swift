import Foundation
#if canImport(CZlib)
import CZlib
#endif

/// Raw DEFLATE (RFC 1951), as Apple's `.zlib` writes it and sync.php reads it.
public func deflateRaw(_ data: Data) -> Data? {
  #if canImport(Darwin)
  try? (data as NSData).compressed(using: .zlib) as Data
  #else
  zlib(data, deflating: true)
  #endif
}

public func inflateRaw(_ data: Data) -> Data? {
  #if canImport(Darwin)
  try? (data as NSData).decompressed(using: .zlib) as Data
  #else
  zlib(data, deflating: false)
  #endif
}

#if !canImport(Darwin)
/// Level 5, nearest Apple's `.zlib` in size (2975 bytes to its 2965 on a 15 kB push), though not its bytes
private func zlib(_ data: Data, deflating: Bool) -> Data? {
  var s = z_stream()
  let begun = deflating
    ? deflateInit2_(&s, 5, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
    : inflateInit2_(&s, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
  guard begun == Z_OK else { return nil }
  defer { _ = deflating ? deflateEnd(&s) : inflateEnd(&s) }
  var input = [UInt8](data), out = Data(), chunk = [UInt8](repeating: 0, count: 16384)
  return input.withUnsafeMutableBufferPointer { inp -> Data? in
    s.next_in = inp.baseAddress
    s.avail_in = uInt(inp.count)
    while true {
      let code: Int32 = chunk.withUnsafeMutableBufferPointer { c in
        s.next_out = c.baseAddress
        s.avail_out = uInt(c.count)
        return deflating ? CZlib.deflate(&s, Z_FINISH) : CZlib.inflate(&s, Z_NO_FLUSH)
      }
      out.append(contentsOf: chunk[0..<(chunk.count - Int(s.avail_out))])
      if code == Z_STREAM_END { return out }
      guard code == Z_OK || code == Z_BUF_ERROR, s.avail_out == 0 || code == Z_OK else { return nil }
    }
  }
}
#endif
