import Testing
@testable import BreezyKit

@Test func rebaseTakesMyChangesOntoTheirs() {
  let base = board([card("a", 0, 0, "x")])
  var mine = base
  mine.setColor(["a"], 3)
  var theirs = base
  theirs.setText("a", "y")
  let r = Board.rebase(base: base, mine: mine, theirs: theirs)
  #expect(r.card("a")!.color == 3 && r.card("a")!.text == "y")
}

@Test func rebaseLetsTheirsWinAFieldBothChanged() {
  let base = board([card("a", 0, 0)])
  var mine = base
  mine.setColor(["a"], 3)
  var theirs = base
  theirs.setColor(["a"], 4)
  #expect(Board.rebase(base: base, mine: mine, theirs: theirs).card("a")!.color == 4)
}

@Test func rebaseRemovesWhatIRemovedUnlessTheyChangedIt() {
  let base = board([card("a", 0, 0), card("b", 0, 0)], [lane("l", 0, 0)])
  var theirs = base
  theirs.setText("b", "kept")
  let r = Board.rebase(base: base, mine: Board(), theirs: theirs)
  #expect(r.cards.map(\.id) == ["b"])
  #expect(r.lanes.isEmpty)
}

@Test func rebaseKeepsWhatTheyAddedAndTheOrderIChose() {
  let base = board([card("a", 0, 0), card("b", 0, 0)])
  let mine = board([card("b", 0, 0), card("a", 0, 0)])
  var theirs = base
  theirs.cards.append(card("c", 0, 0))
  #expect(Board.rebase(base: base, mine: mine, theirs: theirs).cards.map(\.id) == ["b", "a", "c"])
}

@Test func rebaseBringsBackWhatIAdded() {
  let base = board([card("a", 0, 0)])
  let mine = board([card("a", 0, 0), card("n", 0, 96)])
  #expect(Board.rebase(base: base, mine: mine, theirs: base).cards.map(\.id) == ["a", "n"])
}
