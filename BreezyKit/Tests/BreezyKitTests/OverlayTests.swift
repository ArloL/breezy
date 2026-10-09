import Foundation
import Testing
@testable import BreezyKit

@Test func liveFieldsAreWhatAGestureChangedOfItsItems() {
  let start = board([card("a", 0, 0, "x"), card("b", 0, 96)], [lane("l", 0, 0)])
  var now = start
  now.cards[0].x = 48
  now.cards[0].text = "typed"
  now.cards[1].x = 480
  now.lanes[0].w = 720
  now.cards.append(card("n", 24, 24, "new"))
  let f = Records.liveFields(from: start, to: now, ids: ["a", "l", "n"], board: "B")
  #expect(f["a"] == ["pos": .array([.number(48), .number(0)]), "text": .string("typed")])
  #expect(f["b"] == nil)
  #expect(f["l"] == ["size": .array([.number(720), .number(720)])])
  #expect(f["n"]?["kind"] == .string("card"))
  #expect(f["n"]?["text"] == .string("new"))
  #expect(f["n"]?["order"] == nil)
}

@Test func anOverlayIsDrawnOverTheBoard() {
  let b = board([card("a", 0, 0, "x")], [lane("l", 0, 0)])
  let shown = b.overlaid([
    "a": ["pos": .array([.number(48), .number(24)]), "text": .string("typed"), "notes": .string(""), "color": .number(3)],
    "l": ["pos": .array([.number(10), .number(20)]), "size": .array([.number(500), .number(600)]), "title": .string("Now")],
    "n": ["kind": .string("card"), "pos": .array([.number(1), .number(2)]), "w": .number(240), "text": .string("new"),
          "notes": .string(""), "color": .number(1)],
    "gone": ["pos": .array([.number(1), .number(2)])],
  ])
  #expect(shown.card("a") == Card(id: "a", x: 48, y: 24, text: "typed", color: 3))
  #expect(shown.lane("l") == Lane(id: "l", x: 10, y: 20, w: 500, h: 600, title: "Now"))
  #expect(shown.card("n")?.text == "new")
  #expect(shown.cards.count == 2 && shown.lanes.count == 1)
  #expect(b.overlaid([:]) == b)
}
