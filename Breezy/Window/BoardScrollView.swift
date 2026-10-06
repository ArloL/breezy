import AppKit

/// ⌘-scroll zooms around the pointer; pinch is the scroll view's own.
final class BoardScrollView: NSScrollView {
  override func scrollWheel(with event: NSEvent) {
    guard event.modifierFlags.contains(.command), let doc = documentView else { return super.scrollWheel(with: event) }
    let p = doc.convert(event.locationInWindow, from: nil)
    let step = event.hasPreciseScrollingDeltas ? 0.01 : 0.1
    setMagnification(magnification * exp(event.scrollingDeltaY * step), centeredAt: p)
  }
}
