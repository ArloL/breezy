import AppKit

// Draws the app icon and writes Breezy.icns into the directory given.
let out = URL(fileURLWithPath: CommandLine.arguments[1])

func png(_ px: Int, _ draw: (CGFloat) -> Void) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(CGFloat(px))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

func hex(_ v: UInt32) -> NSColor {
  NSColor(srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

/// A yellow card with a title rule and two body rules, in a square of side `s`.
func card(_ r: NSRect) {
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
  shadow.shadowOffset = NSSize(width: 0, height: -r.height * 0.03)
  shadow.shadowBlurRadius = r.height * 0.06
  NSGraphicsContext.saveGraphicsState()
  shadow.set()
  hex(0xf8eca2).setFill()
  NSBezierPath(roundedRect: r, xRadius: r.width * 0.02, yRadius: r.width * 0.02).fill()
  NSGraphicsContext.restoreGraphicsState()
  hex(0x2b2a27).setFill()
  let lh = r.height * 0.07
  NSRect(x: r.minX + r.width * 0.12, y: r.maxY - r.height * 0.28, width: r.width * 0.56, height: lh).fill()
  hex(0x2b2a27).withAlphaComponent(0.4).setFill()
  NSRect(x: r.minX + r.width * 0.12, y: r.maxY - r.height * 0.48, width: r.width * 0.72, height: lh * 0.7).fill()
  NSRect(x: r.minX + r.width * 0.12, y: r.maxY - r.height * 0.62, width: r.width * 0.5, height: lh * 0.7).fill()
}

func appIcon(_ s: CGFloat) {
  let tile = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
  hex(0xf1efea).setFill()
  NSBezierPath(roundedRect: tile, xRadius: s * 0.18, yRadius: s * 0.18).fill()
  hex(0x2b2a27).withAlphaComponent(0.18).setFill()
  for i in 1..<6 { for j in 1..<6 {
    let d = s * 0.012
    NSBezierPath(ovalIn: NSRect(x: tile.minX + tile.width * CGFloat(i) / 6 - d, y: tile.minY + tile.height * CGFloat(j) / 6 - d, width: 2 * d, height: 2 * d)).fill()
  } }
  card(NSRect(x: s * 0.24, y: s * 0.3, width: s * 0.52, height: s * 0.36))
}

func icns(_ name: String, _ draw: (CGFloat) -> Void) {
  let set = out.appendingPathComponent("\(name).iconset")
  try? FileManager.default.removeItem(at: set)
  try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
  for size in [16, 32, 128, 256, 512] {
    try! png(size, draw).write(to: set.appendingPathComponent("icon_\(size)x\(size).png"))
    try! png(size * 2, draw).write(to: set.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
  }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  p.arguments = ["-c", "icns", set.path, "-o", out.appendingPathComponent("\(name).icns").path]
  try! p.run()
  p.waitUntilExit()
  try? FileManager.default.removeItem(at: set)
}

icns("Breezy", appIcon)
