class Input {
  constructor(view, board, store) {
    this.view = view;
    this.board = board;
    this.store = store;
    this.root = view.root;
    this.drag = null;
    this.pointer = { x: 0, y: 0 };
    this.root.addEventListener("pointerdown", (e) => this.down(e));
    this.root.addEventListener("pointermove", (e) => {
      this.pointer = view.toWorld(e.clientX, e.clientY);
    });
    this.root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", () => this.up());
    window.addEventListener("keydown", (e) => this.key(e));
  }

  get editable() {
    return !this.store.readOnly;
  }

  down(e) {
    if (e.button !== 0 || e.target.closest("textarea, input")) return;
    document.activeElement?.blur();
    this.view.select([]);
    const v = this.board.data.view;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      const v = this.board.data.view;
      v.x = d.vx + e.clientX - d.sx;
      v.y = d.vy + e.clientY - d.sy;
      this.board.changed();
    }
  }

  up() {
    this.drag = null;
  }

  wheel(e) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : 1;
    const v = this.board.data.view;
    if (e.ctrlKey || e.metaKey) {
      const r = this.root.getBoundingClientRect();
      Object.assign(v, zoomAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * scale * 0.01)));
    } else {
      v.x -= e.deltaX * scale;
      v.y -= e.deltaY * scale;
    }
    this.board.changed();
  }

  key(e) {
    if (e.target.closest?.("textarea, input")) return;
    if (e.key === "Escape") this.view.select([]);
  }
}
