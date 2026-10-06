const FLIP_MS = 260;
const BACK_W = 400;

class View {
  constructor(root, board) {
    this.root = root;
    this.board = board;
    this.world = root.querySelector("#world");
    this.lanesEl = root.querySelector("#lanes");
    this.cardsEl = root.querySelector("#cards");
    this.marqueeEl = root.querySelector("#marquee");
    this.statusEl = document.getElementById("status");
    this.els = new Map();
    this.selected = new Set();
    this.editing = null;
    this.editor = null;
    this.flipped = null;
  }

  render() {
    const { view, cards, lanes } = this.board.data;
    this.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    this.root.style.backgroundSize = `${GRID * view.zoom}px ${GRID * view.zoom}px`;
    this.root.style.backgroundPosition = `${view.x}px ${view.y}px`;
    const live = new Set();
    for (const lane of lanes) {
      live.add(lane.id);
      this.renderLane(lane);
    }
    for (const card of cards) {
      live.add(card.id);
      this.renderCard(card);
    }
    for (const [id, el] of this.els) {
      if (live.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.selected.delete(id);
      if (this.flipped === id) this.flipped = null;
    }
  }

  element(id, parent, html) {
    let el = this.els.get(id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = id;
      el.innerHTML = html;
      parent.append(el);
      this.els.set(id, el);
    }
    return el;
  }

  classes(base, id) {
    return base + (this.selected.has(id) ? " selected" : "") + (this.editing === id ? " editing" : "");
  }

  renderCard(c) {
    const el = this.element(
      c.id,
      this.cardsEl,
      '<div class="front"><div class="title"></div><div class="body"></div></div>' +
        '<div class="back"><div class="heading"></div><div class="notes"></div></div><div class="dog-ear"></div>',
    );
    const flipped = this.flipped === c.id;
    el.className = this.classes(`card c${c.color}`, c.id) + (flipped ? " flipped" : "") + (c.notes ? " has-notes" : "");
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.width = `${flipped ? BACK_W : c.w}px`;
    if (this.editing === c.id) return;
    const [title, ...body] = c.text.split("\n");
    el.querySelector(".title").textContent = title;
    el.querySelector(".body").textContent = body.join("\n");
    el.querySelector(".heading").textContent = title;
    el.querySelector(".notes").textContent = c.notes ?? "";
  }

  renderLane(l) {
    const el = this.element(l.id, this.lanesEl, '<div class="lane-header"></div><div class="lane-resize"></div>');
    el.className = this.classes("lane", l.id);
    el.style.left = `${l.x}px`;
    el.style.top = `${l.y}px`;
    el.style.width = `${l.w}px`;
    el.style.height = `${l.h}px`;
    if (this.editing !== l.id) el.querySelector(".lane-header").textContent = l.title;
  }

  select(ids) {
    this.selected = new Set(ids);
    this.render();
  }

  toggle(id) {
    if (!this.selected.delete(id)) this.selected.add(id);
    this.render();
  }

  heightOf(id) {
    return this.els.get(id)?.offsetHeight ?? 0;
  }

  toWorld(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    const v = this.board.data.view;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }

  // Lifts card `id` and turns it over, putting back the one in hand; null just puts it back.
  // State changes at once so an editor can take focus; a copy of the old face animates away.
  turn(id) {
    if (!this.els.has(id)) id = null;
    if (this.flipped === id) return;
    const els = [this.flipped, id].filter(Boolean).map((x) => this.els.get(x));
    const ghosts = els.map((el) => {
      for (const a of el.getAnimations()) a.cancel();
      const ghost = el.cloneNode(true);
      ghost.classList.add("ghost");
      el.after(ghost);
      return ghost;
    });
    this.flipped = id;
    this.render();
    const half = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : FLIP_MS / 2;
    const rot = (deg) => ({ transform: `perspective(1000px) rotateY(${deg}deg)` });
    for (const g of ghosts) g.animate([rot(0), rot(90)], { duration: half, easing: "ease-in" }).finished.then(() => g.remove());
    for (const el of els) el.animate([rot(-90), rot(0)], { duration: half, delay: half, easing: "ease-out", fill: "backwards" });
  }

  openCardEditor(id, side) {
    this.editing = id;
    const el = this.els.get(id);
    el.classList.add("editing");
    const ta = document.createElement("textarea");
    const card = this.board.card(id);
    ta.value = side === "back" ? (card.notes ?? "") : card.text;
    el.querySelector(`.${side}`).append(ta);
    this.fit(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.editor = ta;
    return ta;
  }

  openLaneEditor(id) {
    this.editing = id;
    const header = this.els.get(id).querySelector(".lane-header");
    const input = document.createElement("input");
    input.value = this.board.lane(id).title;
    header.textContent = "";
    header.append(input);
    input.focus();
    input.select();
    this.editor = input;
    return input;
  }

  closeEditor() {
    this.editor?.remove();
    this.els.get(this.editing)?.classList.remove("editing");
    this.editor = null;
    this.editing = null;
  }

  fit(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  showMarquee(r) {
    Object.assign(this.marqueeEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    this.marqueeEl.hidden = false;
  }

  hideMarquee() {
    this.marqueeEl.hidden = true;
  }

  setStatus(text, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", isError);
  }
}
