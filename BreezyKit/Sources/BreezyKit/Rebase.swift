import Foundation

extension Board {
  /// `mine`'s changes since `base`, made to `theirs` field by field; where `theirs` changed a field
  /// too, `theirs` wins. Undo uses it so that a step back leaves changes from another device alone.
  public static func rebase(base: Board, mine: Board, theirs: Board) -> Board {
    func pick<T: Equatable>(_ b: T, _ m: T, _ t: T) -> T { t == b ? m : t }
    func card(_ b: Card?, _ m: Card?, _ t: Card?) -> Card? {
      switch (b, m, t) {
      case let (b?, m?, t?):
        var c = t
        if t.x == b.x && t.y == b.y {
          c.x = m.x
          c.y = m.y
        }
        c.w = pick(b.w, m.w, t.w)
        c.text = pick(b.text, m.text, t.text)
        c.notes = pick(b.notes, m.notes, t.notes)
        c.color = pick(b.color, m.color, t.color)
        return c
      case let (b?, nil, t?): return t == b ? nil : t
      case (_?, _, nil): return nil
      case let (nil, m?, nil): return m
      case let (nil, _, t?): return t
      case (nil, nil, nil): return nil
      }
    }
    func lane(_ b: Lane?, _ m: Lane?, _ t: Lane?) -> Lane? {
      switch (b, m, t) {
      case let (b?, m?, t?):
        var l = t
        if t.x == b.x && t.y == b.y {
          l.x = m.x
          l.y = m.y
        }
        if t.w == b.w && t.h == b.h {
          l.w = m.w
          l.h = m.h
        }
        l.title = pick(b.title, m.title, t.title)
        return l
      case let (b?, nil, t?): return t == b ? nil : t
      case (_?, _, nil): return nil
      case let (nil, m?, nil): return m
      case let (nil, _, t?): return t
      case (nil, nil, nil): return nil
      }
    }
    func byID<T: Identifiable>(_ xs: [T]) -> [T.ID: T] { Dictionary(xs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }

    let bc = byID(base.cards), mc = byID(mine.cards), tc = byID(theirs.cards)
    var cards: [String: Card] = [:]
    for id in Set(bc.keys).union(mc.keys).union(tc.keys) { cards[id] = card(bc[id], mc[id], tc[id]) }
    let mineIDs = mine.cards.map(\.id), baseIDs = base.cards.map(\.id), theirIDs = theirs.cards.map(\.id)
    let common = Set(mineIDs).intersection(baseIDs)
    let reordered = mineIDs.filter(common.contains) != baseIDs.filter(common.contains)
    let cardOrder = arrange(Set(cards.keys), primary: reordered ? mineIDs : theirIDs, other: reordered ? theirIDs : mineIDs)

    let bl = byID(base.lanes), ml = byID(mine.lanes), tl = byID(theirs.lanes)
    var lanes: [String: Lane] = [:]
    for id in Set(bl.keys).union(ml.keys).union(tl.keys) { lanes[id] = lane(bl[id], ml[id], tl[id]) }
    let laneOrder = arrange(Set(lanes.keys), primary: theirs.lanes.map(\.id), other: mine.lanes.map(\.id))

    return Board(cards: cardOrder.map { cards[$0]! }, lanes: laneOrder.map { lanes[$0]! })
  }

  /// `keep` in `primary`'s order; the rest follow what came before them in `other`.
  static func arrange(_ keep: Set<String>, primary: [String], other: [String]) -> [String] {
    var out = primary.filter(keep.contains)
    var placed = Set(out)
    var last = -1
    for id in other where keep.contains(id) {
      if placed.contains(id) {
        last = max(last, out.firstIndex(of: id)!)
        continue
      }
      last += 1
      out.insert(id, at: last)
      placed.insert(id)
    }
    return out
  }
}
