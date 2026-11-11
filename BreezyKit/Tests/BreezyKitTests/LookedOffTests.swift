import Foundation
import Testing
@testable import BreezyKit

@Test func lookedOffKeepsTheRecordingWithNoSpaceAndSendsNothing() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("looked-off-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: dir) }
  let f = Flight()
  f.frame(Flight.frameFields.dropFirst().map { _ in 1 })
  let at = Date(timeIntervalSince1970: 1_762_891_200)
  let file = try LookedOff.keep(f.recording(), in: dir, at: at)
  #expect(file.lastPathComponent == "2025-11-11T20-00-00Z.json")
  let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
  #expect((json["frames"] as! [String: Any])["rows"] as? [[Double]] != nil)
  #expect(LookedOff.request(f.recording(), invite: SpaceState().invite) == nil)
}

@Test func lookedOffSendsToDiagBesideSyncWithTheSpacesToken() throws {
  var s = SpaceState()
  s.server = "https://example.com/breezy/sync.php"
  s.space = Base64URL.encode(Data(repeating: 1, count: 16))
  s.secret = Base64URL.encode(Data(repeating: 2, count: 32))
  let r = try #require(LookedOff.request(Flight().recording(), invite: s.invite))
  #expect(r.url?.absoluteString == "https://example.com/breezy/diag.php?space=\(s.space!)")
  #expect(r.httpMethod == "POST")
  let token = SpaceKeys(space: Data(repeating: 1, count: 16), secret: Data(repeating: 2, count: 32)).token
  #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer \(Base64URL.encode(token))")
  #expect(r.value(forHTTPHeaderField: "Content-Encoding") == "deflate")
}
