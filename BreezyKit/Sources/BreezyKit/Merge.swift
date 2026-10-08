import Foundation

public struct MergeResult: Equatable, Sendable {
  public var record: Record
  /// A new card keeping text that would otherwise be lost.
  public var copy: Record?
}

/// Three-way merge of one record: `base` as last pulled, `local` as this device has it, `incoming`
/// from the server. Each field takes the side that changed it, the server's when both did; text
/// or notes both sides changed differently, or changed on one side and deleted on the other, go
/// into a copy card so that nothing typed is lost.
public enum Merge {
  static let texts = ["text", "notes"]

  public static func record(base: Record?, local: Record, incoming: Record) -> MergeResult {
    let base = base ?? Record([:])
    if incoming.deleted || local.deleted {
      let survivor = incoming.deleted ? (local.deleted ? nil : local) : incoming
      let marker = incoming.deleted ? incoming : local
      guard let s = survivor, texts.contains(where: { s[$0] != base[$0] }) else { return MergeResult(record: marker, copy: nil) }
      return MergeResult(record: marker, copy: copy(of: s))
    }
    var out: [String: JSONValue] = [:]
    var conflict = false
    for key in Set(base.fields.keys).union(local.fields.keys).union(incoming.fields.keys) {
      let b = base[key], l = local[key], i = incoming[key]
      if l == b {
        out[key] = i
      } else if i == b || i == l {
        out[key] = l
      } else {
        out[key] = i
        if texts.contains(key) { conflict = true }
      }
    }
    return MergeResult(record: Record(out), copy: conflict ? copy(of: local) : nil)
  }

  /// `r` 24 pt right of and below where it was.
  static func copy(of r: Record) -> Record {
    var c = r
    if let p = Records.unpair(r["pos"]) { c["pos"] = Records.pair(p.0 + 24, p.1 + 24) }
    return c
  }
}
