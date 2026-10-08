import Foundation

public enum BoardFormatError: Error, Equatable, LocalizedError {
  case malformed(String)
  case newer(Int)

  public var errorDescription: String? {
    switch self {
    case .malformed(let why): "The board file is damaged: \(why)."
    case .newer(let v): "The board was made by a newer Breezy (format \(v))."
    }
  }
}

/// `.breezy` files: UTF-8 JSON, pretty-printed with sorted keys.
public enum BoardFormat {
  public static let version = 1

  private struct File: Codable {
    var format: Int
    var cards: [Card]
    var lanes: [Lane]
  }

  private struct Header: Decodable {
    var format: Int
  }

  public static func encode(_ board: Board) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try e.encode(File(format: version, cards: board.cards, lanes: board.lanes))
  }

  public static func decode(_ data: Data) throws -> Board {
    guard (try? JSONSerialization.jsonObject(with: data)) != nil else { throw BoardFormatError.malformed("not valid JSON") }
    let d = JSONDecoder()
    guard let header = try? d.decode(Header.self, from: data) else { throw BoardFormatError.malformed("no format number") }
    if header.format > version { throw BoardFormatError.newer(header.format) }
    let file: File
    do {
      file = try d.decode(File.self, from: data)
    } catch {
      throw BoardFormatError.malformed(describe(error))
    }
    let numbers = file.cards.flatMap { [$0.x, $0.y, $0.w] } + file.lanes.flatMap { [$0.x, $0.y, $0.w, $0.h] }
    guard numbers.allSatisfy(\.isFinite) else { throw BoardFormatError.malformed("a position or size is not a number") }
    return repaired(Board(cards: file.cards, lanes: file.lanes))
  }

  /// Gives duplicate ids fresh ones and clamps colours to 1–5.
  static func repaired(_ board: Board) -> Board {
    var b = board
    var seen = Set<String>()
    for i in b.cards.indices {
      while !seen.insert(b.cards[i].id).inserted { b.cards[i].id = newID() }
      b.cards[i].color = min(max(b.cards[i].color, 1), 5)
    }
    for i in b.lanes.indices {
      while !seen.insert(b.lanes[i].id).inserted { b.lanes[i].id = newID() }
    }
    return b
  }

  private static func describe(_ error: Error) -> String {
    guard let e = error as? DecodingError else { return "unreadable" }
    switch e {
    case .keyNotFound(let key, let ctx): return "missing \(path(ctx.codingPath + [key]))"
    case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx): return "wrong value at \(path(ctx.codingPath))"
    case .dataCorrupted(let ctx): return "unreadable value at \(path(ctx.codingPath))"
    @unknown default: return "unreadable"
    }
  }

  private static func path(_ keys: [CodingKey]) -> String {
    keys.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
  }
}
