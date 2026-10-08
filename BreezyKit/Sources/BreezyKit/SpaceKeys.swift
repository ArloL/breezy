import CryptoKit
import Foundation

/// What a space's secret gives: the key that seals records and the token the server checks.
public struct SpaceKeys {
  public let space: Data
  public let token: Data
  let key: SymmetricKey

  public init(space: Data, secret: Data) {
    let ikm = SymmetricKey(data: secret)
    func derive(_ info: String) -> SymmetricKey {
      HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data(info.utf8), outputByteCount: 32)
    }
    self.space = space
    key = derive("breezy key")
    token = derive("breezy token").withUnsafeBytes { Data($0) }
  }

  /// Nonce, ciphertext and tag; the space and record ids are bound in, so the blob opens nowhere else.
  public func seal(_ plaintext: Data, id: Data, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> Data {
    try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: space + id).combined!
  }

  public func open(_ blob: Data, id: Data) throws -> Data {
    try AES.GCM.open(AES.GCM.SealedBox(combined: blob), using: key, authenticating: space + id)
  }
}

/// What joins a device to a space: the server, the space and its secret, as a link.
public struct Invite: Codable, Equatable, Sendable {
  public static let prefix = "https://arlol.github.io/breezy/#join="
  public var server: String
  public var space: String
  public var secret: String

  public init(server: String, space: String, secret: String) {
    self.server = server
    self.space = space
    self.secret = secret
  }

  public var link: String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return Self.prefix + Base64URL.encode(try! e.encode(self))
  }

  /// The invite in pasted text, which may hold more than the link.
  public init?(link text: String) {
    guard let r = text.range(of: "#join=") else { return nil }
    let token = String(text[r.upperBound...].prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    guard let data = Base64URL.decode(token), let i = try? JSONDecoder().decode(Invite.self, from: data),
          Self.validServer(i.server), Base64URL.decode(i.space)?.count == 16, Base64URL.decode(i.secret)?.count == 32
    else { return nil }
    self = i
  }

  /// HTTPS, or plain HTTP to this computer for trying the server out.
  public static func validServer(_ s: String) -> Bool {
    guard let u = URL(string: s), let host = u.host, !host.isEmpty else { return false }
    return u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
  }
}
