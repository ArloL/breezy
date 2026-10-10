import BreezyKit
import Foundation

/// A relay socket through the hub: `ws-connect`, `ws-send` and `ws-close` out; `ws-open`, `ws-msg` and `ws-close` in.
/// Once closed from either side, it neither sends nor hears anything.
@MainActor final class SimSocket: LiveSocket {
  let id: Int
  private weak var device: SimDevice?
  var onOpen: (() -> Void)?
  var onMessage: ((String) -> Void)?
  var onData: ((Data) -> Void)?
  var onClose: ((Int) -> Void)?
  private var closed = false

  init(_ id: Int, url: URL, device: SimDevice) {
    self.id = id
    self.device = device
    device.emit("ws-connect", ["sock": .int(id), "url": .string(url.absoluteString)])
  }

  func send(_ text: String) {
    guard !closed else { return }
    device?.emit("ws-send", ["sock": .int(id), "text": .string(text)])
  }

  func sendData(_ data: Data) {
    guard !closed else { return }
    device?.emit("ws-send", ["sock": .int(id), "bytes": .bytes(data)])
  }

  func close() {
    guard !closed else { return }
    closed = true
    device?.emit("ws-close", ["sock": .int(id)])
  }

  /// A `ws-open`, `ws-msg` or `ws-close` from the hub.
  func heard(_ cmd: String, _ c: JSONValue) throws {
    guard !closed else { return }
    switch cmd {
    case "ws-open": onOpen?()
    case "ws-msg":
      switch try c.message() {
      case let .text(t): onMessage?(t)
      case let .bytes(d): onData?(d)
      }
    default:
      closed = true
      onClose?(c["code"]?.int ?? 1006)
    }
  }
}
