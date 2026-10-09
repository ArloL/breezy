import CryptoKit
import Foundation
import Testing
@testable import BreezyKit

private struct Vector: Decodable {
  var secret, space, id, nonce, plaintext, token, tokenHash, blob, server, invite, namedInvite: String
}

private func vector() throws -> Vector { try JSONDecoder().decode(Vector.self, from: fixture("crypto.json")) }

@Test func encryptionMatchesTheSharedVector() throws {
  let v = try vector()
  let keys = SpaceKeys(space: Base64URL.decode(v.space)!, secret: Base64URL.decode(v.secret)!)
  let id = Base64URL.decode(v.id)!
  #expect(Base64URL.encode(keys.token) == v.token)
  #expect(Base64URL.encode(Data(SHA256.hash(data: keys.token))) == v.tokenHash)
  let sealed = try keys.seal(Data(v.plaintext.utf8), id: id, nonce: AES.GCM.Nonce(data: Base64URL.decode(v.nonce)!))
  #expect(Base64URL.encode(sealed) == v.blob)
  #expect(try keys.open(Base64URL.decode(v.blob)!, id: id) == Data(v.plaintext.utf8))
}

@Test func aBlobMovedToAnotherRecordDoesNotOpen() throws {
  let keys = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  let blob = try keys.seal(Data("x".utf8), id: randomBytes(16))
  #expect(throws: (any Error).self) { try keys.open(blob, id: randomBytes(16)) }
}

@Test func invitesGoToLinksAndBack() throws {
  let v = try vector()
  let invite = Invite(link: v.invite)
  #expect(invite == Invite(server: v.server, space: v.space, secret: v.secret))
  #expect(Invite(link: invite!.link) == invite)
  #expect(invite!.link.hasPrefix(Invite.prefix))
}

@Test func aPastedInviteMayHaveTextAroundIt() throws {
  let v = try vector()
  #expect(Invite(link: "Join me: \(v.invite)).\n") == Invite(server: v.server, space: v.space, secret: v.secret))
}

@Test func whatIsNotAnInviteIsRefused() throws {
  let v = try vector()
  for text in [
    "", "https://breezy.k5d.de/", "https://breezy.k5d.de/#join=abc",
    Invite(server: "ftp://example.com", space: v.space, secret: v.secret).link,
    Invite(server: v.server, space: "AAAA", secret: v.secret).link,
    Invite(server: v.server, space: v.space, secret: "AAAA").link,
  ] {
    #expect(Invite(link: text) == nil, "\(text)")
  }
}

@Test func serversMustBeHTTPSOrThisComputer() {
  #expect(Invite.validServer("https://example.com/breezy/sync.php"))
  #expect(Invite.validServer("http://localhost:58566/sync.php"))
  #expect(Invite.validServer("http://127.0.0.1:58566/sync.php"))
  #expect(Invite.validServer("HTTPS://Example.com/breezy/sync.php"))
  #expect(Invite.validServer("http://LOCALHOST:58566/sync.php"))
  #expect(!Invite.validServer("http://example.com/sync.php"))
  #expect(!Invite.validServer("example.com"))
  #expect(!Invite.validServer(""))
}

@Test func anInviteMayNameItsSpace() throws {
  let v = try vector()
  let named = Invite(server: v.server, space: v.space, secret: v.secret, name: "Home & Work")
  #expect(named.link == v.namedInvite)
  #expect(Invite(link: v.namedInvite) == named)
  #expect(Invite(link: v.invite)?.name == nil)
}

private struct LiveVector: Decodable { var secret, space, relayToken, nonce, plaintext, body: String }

@Test func liveMessagesMatchTheSharedVector() throws {
  let v = try JSONDecoder().decode(LiveVector.self, from: fixture("live.json"))
  let keys = SpaceKeys(space: Base64URL.decode(v.space)!, secret: Base64URL.decode(v.secret)!)
  let sealed = try keys.sealLive(Data(v.plaintext.utf8), nonce: AES.GCM.Nonce(data: Base64URL.decode(v.nonce)!))
  #expect(Base64URL.encode(sealed) == v.body)
  #expect(try keys.openLive(Base64URL.decode(v.body)!) == Data(v.plaintext.utf8))
}

@Test func theRelayGetsATokenOfItsOwn() throws {
  let v = try JSONDecoder().decode(LiveVector.self, from: fixture("live.json"))
  let keys = SpaceKeys(space: Base64URL.decode(v.space)!, secret: Base64URL.decode(v.secret)!)
  #expect(Base64URL.encode(keys.relayToken) == v.relayToken)
  #expect(keys.relayToken != keys.token)
}

@Test func liveMessagesAndRecordsNeverPassForEachOther() throws {
  let keys = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  let body = try keys.sealLive(Data("x".utf8))
  #expect(throws: (any Error).self) { try keys.open(body, id: Data("live".utf8)) }
  let blob = try keys.seal(Data("x".utf8), id: randomBytes(16))
  #expect(throws: (any Error).self) { try keys.openLive(blob) }
  let other = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  #expect(throws: (any Error).self) { try other.openLive(body) }
}
