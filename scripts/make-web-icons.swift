import AppKit

// Writes the web app's home-screen icons, full-bleed as iOS wants them, into the directory given: 180 px
// for iOS, 192 and 512 for installing on Android.
let out = URL(fileURLWithPath: CommandLine.arguments[1])

func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
}

for px in [180, 192, 512] {
  let s = CGFloat(px)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  hex(0xf1efea).setFill()
  NSRect(x: 0, y: 0, width: s, height: s).fill()
  let card = NSRect(x: s * 0.2, y: s * 0.26, width: s * 0.6, height: s * 0.48)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.22)
  shadow.shadowOffset = NSSize(width: 0, height: -s * 0.015)
  shadow.shadowBlurRadius = s * 0.04
  NSGraphicsContext.saveGraphicsState()
  shadow.set()
  hex(0xf8eca2).setFill()
  card.fill()
  NSGraphicsContext.restoreGraphicsState()
  hex(0x2b2a27, 0.8).setFill()
  NSRect(x: card.minX + s * 0.06, y: card.maxY - s * 0.13, width: card.width * 0.55, height: s * 0.04).fill()
  hex(0x2b2a27, 0.35).setFill()
  for i in 0..<2 {
    NSRect(x: card.minX + s * 0.06, y: card.maxY - s * 0.23 - CGFloat(i) * s * 0.08, width: card.width * (i == 0 ? 0.75 : 0.5), height: s * 0.025).fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("icon-\(px).png"))
}
