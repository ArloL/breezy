import BreezyKit
import WebKit

/// `PeerTransport` over WebRTC in a hidden web view, as macOS gives apps no RTCPeerConnection; see the WebRTC design.
/// Each transport keys its peers with a prefix of its own in the one page they share.
@MainActor final class WebPeerTransport: PeerTransport {
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, String) -> Void)?
  let prefix = UUID().uuidString + " "
  private let page = PeerPage.shared

  init() { page.register(self) }

  private func key(_ peer: String) -> String { prefix + peer }

  func create(_ peer: String) { page.call("create(id)", ["id": key(peer)]) }

  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void) {
    page.call("return await offer(id, restart)", ["id": key(peer), "restart": restart]) { done($0 as? String) }
  }

  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void) {
    page.call("return await answer(id, sdp)", ["id": key(peer), "sdp": offer]) { done($0 as? String) }
  }

  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void) {
    page.call("return await accept(id, sdp)", ["id": key(peer), "sdp": answer]) { done($0 as? Bool ?? false) }
  }

  func add(_ peer: String, candidate c: IceCandidate) {
    page.call("add(id, c)", ["id": key(peer), "c": ["candidate": c.candidate, "mid": c.mid as Any, "index": c.index as Any]])
  }

  /// Hands the text to the page; whether the channel was open shows in `onState`, so this reports only that it went.
  func send(_ peer: String, _ text: String) -> Bool {
    page.call("send(id, text)", ["id": key(peer), "text": text])
    return true
  }

  func close(_ peer: String) { page.call("close(id)", ["id": key(peer)]) }

  /// A message from the page about one of this transport's peers.
  func heard(_ peer: String, _ m: [String: Any]) {
    switch m["kind"] as? String {
    case "candidate":
      let c = (m["candidate"] as? [String: Any]).flatMap { c in
        (c["candidate"] as? String).map { IceCandidate(candidate: $0, mid: c["mid"] as? String, index: (c["index"] as? NSNumber)?.intValue) }
      }
      onCandidate?(peer, c)
    case "state":
      if let s = (m["state"] as? String).flatMap({ PeerState(rawValue: $0) }) { onState?(peer, s) }
    case "message":
      if let t = m["text"] as? String { onMessage?(peer, t) }
    default:
      break
    }
  }
}

/// The hidden page that runs every peer connection, loaded once; calls made before it loads wait for it.
@MainActor final class PeerPage: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = PeerPage()
  private let web: WKWebView
  private var loaded = false
  private var waiting: [() -> Void] = []
  private var transports: [String: () -> WebPeerTransport?] = [:]

  private override init() {
    let config = WKWebViewConfiguration()
    // Breezy is rarely the active app while two screens sit side by side
    config.preferences.inactiveSchedulingPolicy = .none
    web = WKWebView(frame: .zero, configuration: config)
    super.init()
    // the web view copied its configuration, but shares its content controller
    web.configuration.userContentController.add(self, name: "peer")
    web.navigationDelegate = self
    let url = Bundle.main.url(forResource: "peer", withExtension: "html")!
    // the load Task 15 chose; this is (a)
    web.loadHTMLString(try! String(contentsOf: url, encoding: .utf8), baseURL: URL(string: "https://peer.breezy.invalid/"))
  }

  func register(_ t: WebPeerTransport) { transports[t.prefix] = { [weak t] in t } }

  func call(_ js: String, _ args: [String: Any], _ done: (@MainActor (Any?) -> Void)? = nil) {
    guard loaded else { return waiting.append { [weak self] in self?.call(js, args, done) } }
    web.callAsyncJavaScript(js, arguments: args, in: nil, in: .page) { result in
      MainActor.assumeIsolated { done?(try? result.get()) }
    }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded = true
      let w = waiting
      waiting = []
      w.forEach { $0() }
    }
  }

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      guard let m = message.body as? [String: Any], let id = m["id"] as? String, let space = id.firstIndex(of: " ") else { return }
      let prefix = String(id[...space])
      guard let t = transports[prefix]?() else { return transports[prefix] = nil }
      t.heard(String(id[id.index(after: space)...]), m)
    }
  }
}
