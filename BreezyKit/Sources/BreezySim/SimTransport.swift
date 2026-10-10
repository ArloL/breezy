import BreezyKit
import Foundation

/// `HTTPTransport`'s sending, through the hub: the request goes out as an `http` event and waits for the hub's `http`
/// command. As URLSession does, it gives up after the request's `timeoutInterval`, on the device's clock, with
/// `URLError(.timedOut)`, and answers a cancelled task with `URLError(.cancelled)`; either sends `http-cancel`, so that
/// the hub drops the answer.
extension SimDevice {
  struct Request {
    var continuation: CheckedContinuation<(Data, URLResponse), Error>
    var url: URL
    var timer: Int
  }

  func send(_ r: URLRequest) async throws -> (Data, URLResponse) {
    if Task.isCancelled { throw URLError(.cancelled) }
    requestCount += 1
    let req = requestCount
    let headers = (r.allHTTPHeaderFields ?? [:]).mapValues(JSONValue.string)
    emit("http", [
      "req": .int(req), "method": .string(r.httpMethod ?? "GET"), "url": .string(r.url?.absoluteString ?? ""),
      "headers": .object(headers), "body": r.httpBody.map(JSONValue.bytes) ?? .null,
    ])
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { c in
        let timer = after(r.timeoutInterval * 1000) { [weak self] in self?.finish(req, .failure(URLError(.timedOut)), dropped: true) }
        requests[req] = Request(continuation: c, url: r.url ?? URL(string: "about:blank")!, timer: timer)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.finish(req, .failure(URLError(.cancelled)), dropped: true) }
    }
  }

  /// The hub's answer: `status` and `body`, or `error`, "offline" or "unreachable".
  func answer(_ c: JSONValue) throws {
    let req = try c.int("req")
    guard let r = requests[req] else { return }
    if let error = c["error"]?.string {
      return finish(req, .failure(URLError(error == "offline" ? .notConnectedToInternet : .cannotConnectToHost)), dropped: false)
    }
    let headers = c["headers"]?.object?.compactMapValues(\.string)
    let response = HTTPURLResponse(url: r.url, statusCode: try c.int("status"), httpVersion: "HTTP/1.1", headerFields: headers)!
    let body = c["body"]?.string.flatMap(Base64URL.decode) ?? Data()
    finish(req, .success((body, response)), dropped: false)
  }

  private func finish(_ req: Int, _ result: Result<(Data, URLResponse), Error>, dropped: Bool) {
    guard let r = requests.removeValue(forKey: req) else { return }
    cancelTimer(r.timer)
    if dropped { emit("http-cancel", ["req": .int(req)]) }
    r.continuation.resume(with: result)
  }
}
