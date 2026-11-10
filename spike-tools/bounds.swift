import AppKit
let pid = NSRunningApplication.runningApplications(withBundleIdentifier: CommandLine.arguments[1]).first?.processIdentifier
for w in (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []) where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as! [String: Double]
  print(Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!)); break
}
