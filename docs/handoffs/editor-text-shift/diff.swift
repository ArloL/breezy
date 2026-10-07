import AppKit
let a = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
let b = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))!
var n = 0, minX = Int.max, minY = Int.max, maxX = 0, maxY = 0
for y in 0..<a.pixelsHigh { for x in 0..<a.pixelsWide {
  let p = a.colorAt(x: x, y: y)!, q = b.colorAt(x: x, y: y)!
  if abs(p.redComponent - q.redComponent) + abs(p.greenComponent - q.greenComponent) + abs(p.blueComponent - q.blueComponent) > 0.06 {
    n += 1; minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y) } } }
print("\(n) differing pixels in x \(minX)...\(maxX) y \(minY)...\(maxY)")
