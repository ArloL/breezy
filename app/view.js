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
    const el = this.element(c.id, this.cardsEl, '<div class="title"></div><div class="body"></div>');
    el.className = this.classes(`card c${c.color}`, c.id);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.width = `${c.w}px`;
    if (this.editing === c.id) return;
    const [title, ...body] = c.text.split("\n");
    el.querySelector(".title").textContent = title;
    el.querySelector(".body").textContent = body.join("\n");
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

  openCardEditor(id) {
    this.editing = id;
    const el = this.els.get(id);
    el.classList.add("editing");
    const ta = document.createElement("textarea");
    ta.value = this.board.card(id).text;
    el.append(ta);
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
