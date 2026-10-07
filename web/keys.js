const ANYWHERE = new Set(["find", "find-next", "find-previous", "zoom-in", "zoom-out", "zoom-reset"]);

/**
 * The command for key event `e`, as the Mac app's keys and menus have them, or null to leave the key alone. `typing` is
 * what has the keyboard: null for the board, "card", "lane" or "field" (the find field).
 */
export function command(e, { mac, typing }) {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && !other) {
    const cmd = modified(k, e.shiftKey);
    if (!cmd) return null;
    if (ANYWHERE.has(cmd)) return cmd;
    if (cmd === "end-edit") return typing === "card" ? cmd : null;
    if (cmd === "undo" || cmd === "redo") return typing === "field" ? null : cmd;
    return typing ? null : cmd;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (typing === "card") return k === "Escape" ? "end-edit" : k === "Tab" && !e.shiftKey ? "switch-side" : null;
  if (typing === "lane") return k === "Tab" ? "end-edit" : null;
  if (typing) return null;
  // by position, as ⇧0 types "=" on some layouts
  if (e.shiftKey && e.code === "Digit0") return "zoom-reset";
  if (k === " ") return "turn";
  if (k === "Escape") return "escape";
  if (k === "Backspace" || k === "Delete") return "delete";
  if (k === "l") return "new-lane";
  if (/^[1-5]$/.test(k)) return `colour-${k}`;
  return null;
}

function modified(k, shift) {
  if (k === "z") return shift ? "redo" : "undo";
  if (k === "g") return shift ? "find-previous" : "find-next";
  if (k === "=" || k === "+") return "zoom-in";
  if (k === "-" && !shift) return "zoom-out";
  if (k === "0" && !shift) return "zoom-reset";
  if (shift) return null;
  return { a: "select-all", f: "find", e: "find-selection", Enter: "end-edit" }[k] ?? null;
}

/** Runs command `cmd`; `mouse` knows the card under the pointer and where the pointer is. */
export function perform(app, cmd, mouse) {
  const s = app.state;
  const ui = app.ui;
  switch (cmd) {
    case "undo": return app.undo();
    case "redo": return app.redo();
    case "select-all": return app.selectAll();
    case "find": app.endEditing(); return ui.openFind();
    case "find-next": app.endEditing(); return ui.findStep(1);
    case "find-previous": app.endEditing(); return ui.findStep(-1);
    case "find-selection": {
      const [c] = app.selectedCards();
      return c && ui.openFind(c.text.split("\n")[0]);
    }
    case "zoom-in": return app.zoomBy(1.25);
    case "zoom-out": return app.zoomBy(1 / 1.25);
    case "zoom-reset": return app.zoomTo(1);
    case "end-edit": return app.endEditing();
    case "switch-side": return app.switchSide();
    case "turn": {
      const sel = app.selectedCards();
      const id = mouse.hoveredCard() ?? (sel.length === 1 && s.selection.size === 1 ? sel[0].id : null);
      return app.turn(id === s.turned ? null : id);
    }
    case "escape": return s.turned ? app.turn(null) : app.select([]);
    case "delete": return s.selection.size && app.removeSelection();
    case "new-lane": return app.newLane(mouse.pointer ? app.view.toWorld(mouse.pointer) : undefined);
    default:
      if (cmd.startsWith("colour-")) return app.colour(Number(cmd.slice(7)));
  }
}
