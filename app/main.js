{
  const board = new Board(JSON.parse(document.getElementById("board-data").textContent));
  const view = new View(document.getElementById("board"), board);
  const store = new Store(board, view);
  board.onChange = () => {
    view.render();
    store.schedule();
  };
  new Input(view, board, store);
  document.getElementById("add-lane").disabled = store.readOnly;
  view.render();
}
