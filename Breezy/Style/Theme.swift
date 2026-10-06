import AppKit

/// Colour tokens with light and dark values. Layers take CGColors, so they resolve these with
/// `cg(_:in:)` and re-apply them when the appearance changes.
enum Theme {
  static let paper = dynamic(0xf1efea, 0x1f1e1c)
  static let ink = dynamic(0x2b2a27, 0xe9e6df)
  static let ink2 = dynamic(0x2b2a27, 0xe9e6df, alpha: 0.68)
  static let ink3 = dynamic(0x2b2a27, 0xe9e6df, alpha: 0.42)
  static let hairline = dynamic(0x2b2a27, 0xe9e6df, alpha: 0.12)
  static let dot = dynamic(0x2b2a27, 0xe9e6df, alpha: 0.16)
  static let accent = dynamic(0xe8620a, 0xff8a3d)
  static let laneFill = NSColor(name: nil) { $0.isDark ? NSColor(white: 1, alpha: 0.04) : NSColor(white: 1, alpha: 0.45) }
  static let tints = [
    dynamic(0xf8eca2, 0x4f4628), dynamic(0xf5d2ca, 0x553a35), dynamic(0xcfe0ee, 0x2f4152),
    dynamic(0xd6e6c6, 0x384731), dynamic(0xe3e0d9, 0x403e3a),
  ]

  static func tint(_ color: Int) -> NSColor { tints[min(max(color, 1), 5) - 1] }

  static func cg(_ color: NSColor, in appearance: NSAppearance) -> CGColor {
    var c = color.cgColor
    appearance.performAsCurrentDrawingAppearance { c = color.cgColor }
    return c
  }

  private static func dynamic(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(name: nil) { NSColor(hex: $0.isDark ? dark : light, alpha: alpha) }
  }
}

extension NSAppearance {
  var isDark: Bool { bestMatch(from: [.aqua, .darkAqua]) == .darkAqua }
}

extension NSColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
              blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
  }
}
