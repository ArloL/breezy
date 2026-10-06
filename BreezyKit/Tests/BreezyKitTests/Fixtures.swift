@testable import BreezyKit

func board(_ cards: [Card] = [], _ lanes: [Lane] = []) -> Board { Board(cards: cards, lanes: lanes) }
func card(_ id: String, _ x: Double, _ y: Double, _ text: String = "t") -> Card { Card(id: id, x: x, y: y, text: text) }
func lane(_ id: String, _ x: Double, _ y: Double, _ w: Double = 480, _ h: Double = 720) -> Lane {
  Lane(id: id, x: x, y: y, w: w, h: h)
}
let h48: HeightOf = { _ in 48 }
func ys(_ b: Board, _ ids: String...) -> [Double] { ids.map { b.card($0)!.y } }
