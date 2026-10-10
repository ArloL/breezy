import BreezyKit
import Foundation

/// A device's state for the hub's checks, canonical so that a web device's equals a Swift one's: cards and lanes in the
/// store's order, `notes` and `title` "" when absent, numbers as the store has them. Over all the device's spaces:
/// `pending` and `mine` add up, `connected` needs every live layer connected, `status` is the first space's.
enum Snapshot {
  @MainActor static func of(_ spaces: Spaces) -> JSONValue {
    var boards: Fields = [:], overlays: Fields = [:], seen: Set<String> = []
    var pending = 0, mine = 0
    for g in spaces.spaces {
      for (id, title) in g.store.boards {
        let b = g.store.board(id)
        boards[id] = .object([
          "title": .string(title),
          "cards": .array(b.cards.map { c in
            .object([
              "id": .string(c.id), "x": .number(c.x), "y": .number(c.y), "w": .number(c.w), "text": .string(c.text),
              "notes": .string(c.notes ?? ""), "color": .int(c.color),
            ])
          }),
          "lanes": .array(b.lanes.map { l in
            .object([
              "id": .string(l.id), "x": .number(l.x), "y": .number(l.y), "w": .number(l.w), "h": .number(l.h), "title": .string(l.title),
            ])
          }),
        ])
        overlays[id] = .int(g.live?.overlay(on: id).count ?? 0)
      }
      pending += g.store.pending.count
      mine += g.live?.mine.count ?? 0
      seen.formUnion(g.live?.peers.values.compactMap(\.person?.device) ?? [])
    }
    let connected = !spaces.spaces.isEmpty && spaces.spaces.allSatisfy { $0.live?.connected == true }
    return .object([
      "boards": .object(boards), "pending": .int(pending), "overlays": .object(overlays), "mine": .int(mine),
      "connected": .bool(connected), "seen": .array(seen.sorted().map(JSONValue.string)),
      "status": .string(status(spaces.spaces.first?.engine.status.state ?? .local)),
    ])
  }

  static func status(_ s: SyncStatus.State) -> String {
    switch s {
    case .local: "local"
    case .synced: "synced"
    case .offline: "offline"
    case .unreachable: "unreachable"
    case .notInSpace: "notInSpace"
    }
  }
}
