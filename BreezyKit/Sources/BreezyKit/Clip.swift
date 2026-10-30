import Foundation

/// A card as the clipboard carries it: where and how tall it stood, for placing its copy.
public struct ClipCard: Codable, Equatable, Sendable {
  public var id: String
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double
  public var text: String
  public var color: Int
  public var notes: String?

  public init(id: String, x: Double, y: Double, w: Double, h: Double, text: String, color: Int, notes: String? = nil) {
    self.id = id
    self.x = x
    self.y = y
    self.w = w
    self.h = h
    self.text = text
    self.color = color
    self.notes = notes
  }

  /// A size, colour or notes of the wrong type or missing is mended as the web app mends it, not refused.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    x = try c.decode(Double.self, forKey: .x)
    y = try c.decode(Double.self, forKey: .y)
    w = (try? c.decode(Double.self, forKey: .w)) ?? 0
    h = (try? c.decode(Double.self, forKey: .h)) ?? 0
    text = try c.decode(String.self, forKey: .text)
    color = (try? c.decode(Double.self, forKey: .color)).map { Int($0.rounded().clamped(1, 5)) } ?? 1
    notes = try? c.decode(String.self, forKey: .notes)
  }
}

/// Cards copied from `board`, in reading order; the web app's `Clip`.
public struct Clip: Codable, Equatable, Sendable {
  public var v = 1
  public var board: String
  public var cards: [ClipCard]

  public init(board: String, cards: [ClipCard]) {
    self.board = board
    self.cards = cards
  }

  /// The fronts in the clip's order, a blank line between.
  public var text: String { cards.map(\.text).joined(separator: "\n\n") }

  /// The text as HTML with the clip as JSON in a `data-breezy` attribute, as the web app writes it.
  public var html: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    var json = String(decoding: try! encoder.encode(self), as: UTF8.self)
    json = json.replacingOccurrences(of: "&", with: "\\u0026").replacingOccurrences(of: "<", with: "\\u003c").replacingOccurrences(of: ">", with: "\\u003e")
      .replacingOccurrences(of: "\u{00A0}", with: "\\u00a0")
    return "<div data-breezy=\"\(json.htmlEscaped)\">\(text.htmlEscaped.replacingOccurrences(of: "\n", with: "<br>"))</div>"
  }

  /// The clip in the first `data-breezy` attribute of `html`, wherever the browser put it; nil if there is none or it is no clip.
  public init?(html: String) {
    guard let key = html.range(of: " data-breezy=\"") ?? html.range(of: "\tdata-breezy=\"") ?? html.range(of: "\ndata-breezy=\""),
      let end = html[key.upperBound...].firstIndex(of: "\"")
    else { return nil }
    let json = String(html[key.upperBound..<end]).htmlUnescaped
    guard var clip = try? JSONDecoder().decode(Clip.self, from: Data(json.utf8)),
      clip.v == 1
    else { return nil }
    for i in clip.cards.indices {
      if !(clip.cards[i].w > 0) { clip.cards[i].w = Metrics.cardWidth }
      if !(clip.cards[i].h > 0) { clip.cards[i].h = 2 * Metrics.grid }
      clip.cards[i].color = min(5, max(1, clip.cards[i].color))
      if clip.cards[i].notes == "" { clip.cards[i].notes = nil }
    }
    self = clip
  }
}

extension Double {
  fileprivate func clamped(_ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, self)) }
}

extension String {
  fileprivate var htmlEscaped: String {
    replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
  }

  fileprivate var htmlUnescaped: String {
    var out = ""
    var rest = Substring(self)
    while let amp = rest.firstIndex(of: "&") {
      out += rest[..<amp]
      rest = rest[amp...]
      guard let semi = rest.firstIndex(of: ";"), rest.distance(from: rest.startIndex, to: semi) <= 10 else {
        out += "&"
        rest = rest.dropFirst()
        continue
      }
      let name = rest[rest.index(after: rest.startIndex)..<semi].lowercased()
      let named = ["quot": "\"", "amp": "&", "lt": "<", "gt": ">", "apos": "'", "nbsp": "\u{00A0}"]
      var decoded = named[name]
      if decoded == nil, name.hasPrefix("#") {
        let n = name.hasPrefix("#x") ? UInt32(name.dropFirst(2), radix: 16) : UInt32(name.dropFirst())
        decoded = n.flatMap(Unicode.Scalar.init).map { String(Character($0)) }
      }
      if let decoded {
        out += decoded
        rest = rest[rest.index(after: semi)...]
      } else {
        out += "&"
        rest = rest.dropFirst()
      }
    }
    return out + rest
  }
}

extension Board {
  /// The selected cards, lanes left out, in reading order; nil when none is a card.
  public func clip(board: String, ids: Set<String>, heightOf: HeightOf) -> Clip? {
    let cards = self.cards.filter { ids.contains($0.id) }.sorted { ($0.y, $0.x) < ($1.y, $1.x) }
      .map { ClipCard(id: $0.id, x: $0.x, y: $0.y, w: $0.w, h: heightOf($0.id), text: $0.text, color: $0.color, notes: $0.notes?.isEmpty == false ? $0.notes : nil) }
    return cards.isEmpty ? nil : Clip(board: board, cards: cards)
  }

  /// Adds copies of the clip's cards and returns their ids, in clip order. On the clip's board a copy
  /// of a card in a lane goes right below its original, or, the original gone, before the first card
  /// of that lane's column at or below where it stood; the rest move as a block to the clear space
  /// nearest their originals, or on another board nearest `centre`. Lane copies go one at a time, the
  /// board settled after each, so that a run of cut cards finds its places among those put back. As
  /// the web app's `paste`.
  @discardableResult
  public mutating func paste(_ clip: Clip, board: String, centre: Point, heightOf: HeightOf) -> [String] {
    let same = clip.board == board
    let ids = clip.cards.map { _ in newID() }
    var free: [(ClipCard, Card)] = []
    func home(_ r: Rect) -> Lane? { lanes.first { $0.rect.containsCentre(of: r) } }
    for (k, id) in zip(clip.cards, ids) {
      var copy = Card(id: id, x: k.x, y: k.y, w: k.w, text: k.text, notes: k.notes, color: k.color)
      let o = same ? card(k.id) : nil
      let kr = Rect(x: k.x, y: k.y, w: k.w, h: k.h)
      let l = same && o == nil ? home(kr) : nil
      if let o, home(o.rect(height: heightOf(o.id))) != nil {
        // Centre just after the original's: settle orders the copy next.
        copy.x = o.x
        copy.y = o.y + heightOf(o.id) / 2 - k.h / 2 + 1
      } else if let l {
        let n = cards.filter { $0.y >= k.y && l.rect.containsCentre(of: $0.rect(height: heightOf($0.id))) && kr.sharesColumn(with: $0.rect(height: heightOf($0.id))) }
          .min { $0.y < $1.y }
        // Centre just before n's.
        if let n { copy.y = n.y + heightOf(n.id) / 2 - k.h / 2 - 1 }
      } else {
        free.append((k, copy))
        continue
      }
      cards.append(copy)
      gravity(heightOf)
    }
    if !free.isEmpty {
      let x0 = free.map(\.0.x).min()!, y0 = free.map(\.0.y).min()!
      let w = free.map { $0.0.x + $0.0.w }.max()! - x0, h = free.map { $0.0.y + $0.0.h }.max()! - y0
      let at = same ? Point(x: x0, y: y0) : Point(x: centre.x - w / 2, y: centre.y - h / 2)
      let s = openSpot(w: w, h: h, near: at.x, at.y, heightOf: heightOf)
      for (k, var c) in free {
        c.x = k.x + s.x - x0
        c.y = k.y + s.y - y0
        cards.append(c)
      }
    }
    gravity(heightOf)
    return ids
  }
}
