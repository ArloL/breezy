import AppKit

/// Hands on each event taken from the queue. NSScrollView takes a pinch's later events itself, which skips local
/// monitors, sendEvent and its overrides: the end of 7 of 8 fast pinches reached none of them, and each was taken here.
final class BreezyApplication: NSApplication {
  private var observers: [ObjectIdentifier: (NSEvent) -> Void] = [:]

  func observeDequeued(by owner: AnyObject, _ f: @escaping (NSEvent) -> Void) { observers[ObjectIdentifier(owner)] = f }
  func stopObserving(by owner: AnyObject) { observers[ObjectIdentifier(owner)] = nil }

  override func nextEvent(matching mask: NSEvent.EventTypeMask, until date: Date?, inMode mode: RunLoop.Mode, dequeue: Bool) -> NSEvent? {
    let e = super.nextEvent(matching: mask, until: date, inMode: mode, dequeue: dequeue)
    if dequeue, let e { observers.values.forEach { $0(e) } }
    return e
  }
}
