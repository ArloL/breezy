import Foundation

/// What looked off to the owner: the recording with its last seconds of frames, kept on disk always and sent to the
/// space's diag.php beside its sync.php when the board is in a space, as web/diag.ts sends with reason "off"
/// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md).
public enum LookedOff {
  /// Writes `r` to `dir`, named by when, and gives the file.
  public static func keep(_ r: Flight.Recording, in dir: URL, at: Date = Date()) throws -> URL {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    let url = dir.appendingPathComponent(f.string(from: at).replacingOccurrences(of: ":", with: "-") + ".json")
    try JSONEncoder().encode(r).write(to: url)
    return url
  }

  /// The request that sends `r` to the diag.php of the space `invite` joins, deflated, with the space's token; nil for
  /// a board in no space.
  public static func request(_ r: Flight.Recording, invite: Invite?) -> URLRequest? {
    guard let server = invite?.server, let id = invite?.space, let secret = invite?.secret,
      let spaceBytes = Base64URL.decode(id), let secretBytes = Base64URL.decode(secret),
      var c = URLComponents(string: server.replacingOccurrences(of: "sync.php", with: "diag.php")) else { return nil }
    struct Body: Encodable {
      let why = "off"
      let recording: Flight.Recording
    }
    guard let json = try? JSONEncoder().encode(Body(recording: r)), let body = deflateRaw(json) else { return nil }
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: id)]
    guard let url = c.url else { return nil }
    var req = URLRequest(url: url, timeoutInterval: 20)
    req.httpMethod = "POST"
    req.httpBody = body
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("deflate", forHTTPHeaderField: "Content-Encoding")
    req.setValue("Bearer \(Base64URL.encode(SpaceKeys(space: spaceBytes, secret: secretBytes).token))", forHTTPHeaderField: "Authorization")
    return req
  }
}
