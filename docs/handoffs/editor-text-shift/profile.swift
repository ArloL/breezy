import AppKit
// ink centroid and mass of the text in a crop (bright text on dark card)
for path in CommandLine.arguments.dropFirst() {
  let r = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: path)))!
  var m = 0.0, sx = 0.0, sy = 0.0
  for y in 0..<r.pixelsHigh { for x in 0..<r.pixelsWide {
    let c = r.colorAt(x: x, y: y)!; let v = max(0, c.brightnessComponent - 0.35)
    m += v; sx += v * Double(x); sy += v * Double(y) } }
  print(path.split(separator: "/").last!, "ink \(Int(m)) centroid x \(String(format: "%.2f", sx / m)) y \(String(format: "%.2f", sy / m))")
}
