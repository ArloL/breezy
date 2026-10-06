class Input {
  constructor(view, board, store) {
    this.view = view;
    this.board = board;
    this.store = store;
    this.root = view.root;
    this.drag = null;
    this.pointer = { x: 0, y: 0 };
    this.root.addEventListener("pointerdown", (e) => this.down(e));
    this.root.addEventListener("dblclick", (e) => this.dblclick(e));
    this.root.addEventListener("pointermove", (e) => {
      this.pointer = view.toWorld(e.clientX, e.clientY);
    });
    this.root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", () => this.up());
    window.addEventListener("pointercancel", () => this.up());
    window.addEventListener("keydown", (e) => this.key(e));
    document.getElementById("add-lane").addEventListener("click", () => this.addLaneAtCentre());
  }

  get editable() {
    return !this.store.readOnly;
  }

  down(e) {
    if (e.button !== 0 || e.target.closest("textarea, input")) return;
    document.activeElement?.blur();
    const p = this.view.toWorld(e.clientX, e.clientY);
    const card = e.target.closest(".card");
    const resize = e.target.closest(".lane-resize");
    const header = e.target.closest(".lane-header");
    if (card) return this.downOnCard(card.dataset.id, e.shiftKey, p);
    if (resize) return this.downOnResize(resize.parentElement.dataset.id, p);
    if (header) return this.downOnLane(header.parentElement.dataset.id, e.shiftKey, p);
    if (e.shiftKey) {
      this.drag = { kind: "marquee", start: p, base: [...this.view.selected] };
      return;
    }
    this.view.select([]);
    const v = this.board.data.view;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  }

  downOnCard(id, shift, p) {
    if (shift) return this.view.toggle(id);
    if (!this.view.selected.has(id)) this.view.select([id]);
    if (!this.editable) return;
    const origins = [...this.view.selected]
      .map((s) => this.board.card(s))
      .filter(Boolean)
      .map((c) => ({ id: c.id, x: c.x, y: c.y }));
    this.board.checkpoint();
    this.drag = { kind: "cards", id, start: p, moved: false, origins };
  }

  downOnLane(id, shift, p) {
    if (shift) return this.view.toggle(id);
    this.view.select([id]);
    if (!this.editable) return;
    const lane = this.board.lane(id);
    const cards = this.board
      .cardsInLane(id, (cid) => this.view.heightOf(cid))
      .map((c) => ({ id: c.id, x: c.x, y: c.y }));
    this.board.checkpoint();
    this.drag = { kind: "lane", start: p, moved: false, lane: { id, x: lane.x, y: lane.y }, cards };
  }

  downOnResize(id, p) {
    this.view.select([id]);
    if (!this.editable) return;
    const lane = this.board.lane(id);
    this.board.checkpoint();
    this.drag = { kind: "resize", id, start: p, moved: false, w: lane.w, h: lane.h };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    // released outside the window, so pointerup never arrived
    if (e.buttons === 0) return this.up();
    if (d.kind === "pan") {
      const v = this.board.data.view;
      v.x = d.vx + e.clientX - d.sx;
      v.y = d.vy + e.clientY - d.sy;
      return this.board.changed();
    }
    const p = this.view.toWorld(e.clientX, e.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.kind === "marquee") {
      const rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      this.view.showMarquee(rect);
      const hits = this.board.cardsInRect(rect, (id) => this.view.heightOf(id)).map((c) => c.id);
      return this.view.select([...d.base, ...hits]);
    }
    d.moved ||= Math.hypot(dx, dy) * this.board.data.view.zoom > 3;
    if (!d.moved) return;
    if (d.kind === "cards") this.board.moveCards(d.origins, dx, dy);
    else if (d.kind === "lane") this.board.moveLane(d.lane, d.cards, dx, dy);
    else if (d.kind === "resize") this.board.resizeLane(d.id, d.w + dx, d.h + dy);
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === "pan") return;
    if (d.kind === "marquee") return this.view.hideMarquee();
    if (d.kind === "cards" && !d.moved) this.view.select([d.id]);
    this.board.dropNoopCheckpoint();
  }

  dblclick(e) {
    if (!this.editable || e.target.closest("textarea, input")) return;
    const card = e.target.closest(".card");
    const header = e.target.closest(".lane-header");
    if (card) return this.editCard(card.dataset.id, false);
    if (header) return this.editLane(header.parentElement.dataset.id);
    if (e.target.closest(".lane-resize")) return;
    const p = this.view.toWorld(e.clientX, e.clientY);
    const created = this.board.addCard(p.x, p.y);
    this.view.select([created.id]);
    this.editCard(created.id, true);
  }

  editCard(id, fresh) {
    if (!fresh) this.board.checkpoint();
    const ta = this.view.openCardEditor(id);
    ta.addEventListener("input", () => {
      this.board.setText(id, ta.value);
      this.view.fit(ta);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) ta.blur();
    });
    ta.addEventListener("blur", () => {
      this.view.closeEditor();
      this.board.finishEdit(id);
    }, { once: true });
  }

  editLane(id) {
    this.board.checkpoint();
    const input = this.view.openLaneEditor(id);
    input.addEventListener("input", () => this.board.setLaneTitle(id, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      this.view.closeEditor();
      this.board.finishEdit(id);
    }, { once: true });
  }

  addLane(x, y) {
    const lane = this.board.addLane(x, y);
    this.view.select([lane.id]);
  }

  addLaneAtCentre() {
    if (!this.editable) return;
    const r = this.root.getBoundingClientRect();
    const c = this.view.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    this.addLane(c.x - LANE_W / 2, c.y - LANE_H / 2);
  }

  key(e) {
    if (e.target.closest?.("textarea, input")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!this.editable) return;
      if (e.shiftKey) this.board.redo();
      else this.board.undo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape") return this.view.select([]);
    if (!this.editable) return;
    if (e.key === "l" || e.key === "L") return this.addLane(this.pointer.x, this.pointer.y);
    if (/^[1-5]$/.test(e.key)) return this.board.setColor([...this.view.selected], Number(e.key));
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      this.board.remove([...this.view.selected]);
      this.view.select([]);
    }
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
}
