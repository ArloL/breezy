import * as R from "./rules.js";

const MODE_KEY = "breezy.panMode";
const KEYS_H = 44;

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

/** Acts on `touchend` and cancels it, so the tap takes no focus from the editor. */
function press(el, fn) {
  el.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (!el.disabled) fn();
  });
  el.addEventListener("click", () => {
    if (!el.disabled) fn();
  });
}

/** The bars around the board: top, find, add and selection, keyboard and settings. */
export class UI {
  constructor(app) {
    this.app = app;
    this.mode = loadMode() === "two" ? "two" : "one";
    this.matches = [];
    this.index = -1;
    this.$ = (sel) => document.querySelector(sel);
    for (const b of document.querySelectorAll("[data-act]")) press(b, () => this.act(b.dataset.act, b));
    const field = this.$("#find input");
    field.addEventListener("input", () => this.find(field.value));
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.step(1);
    });
    visualViewport.addEventListener("resize", () => {
      this.place();
      this.app.revealEditing();
    });
    visualViewport.addEventListener("scroll", () => this.place());
    this.update();
  }

  act(name, b) {
    const app = this.app;
    switch (name) {
      case "undo": return app.undo();
      case "redo": return app.redo();
      case "zoom": return app.view.zoomAround(app.view.centre(), 1, true);
      case "search": return this.openFind();
      case "settings": return this.openSettings();
      case "add": this.$(".menu").hidden = !this.$(".menu").hidden; return;
      case "new-card": this.closeMenu(); return app.newCard(app.view.toWorld(app.view.centre()));
      case "new-lane": this.closeMenu(); return app.newLane();
      case "colour": return app.colour(Number(b.dataset.colour));
      case "turn": {
        const [c] = app.selectedCards();
        return c && app.turn(app.state.turned === c.id ? null : c.id);
      }
      case "pile": return app.takePile();
      case "delete": return app.removeSelection();
      case "key-turn": return app.switchSide();
      case "key-done": return app.endEditing();
      case "prev": return this.step(-1);
      case "next": return this.step(1);
      case "close-find": return this.closeFind();
      case "mode":
        this.mode = b.dataset.mode;
        saveMode(this.mode);
        return this.update();
      case "close-settings": this.$("#settings").hidden = true; return;
    }
  }

  update() {
    const app = this.app;
    const s = app.state;
    const cards = app.selectedCards();
    const lanes = app.selectedLanes();
    const typing = !!(s.editing || s.renaming);
    this.$('[data-act="undo"]').disabled = !(app.model.canUndo || app.model.inGesture);
    this.$('[data-act="redo"]').disabled = !app.model.canRedo;
    this.$("#bottom").hidden = typing;
    const selecting = cards.length + lanes.length > 0;
    this.$("#bottom .selection").hidden = !selecting;
    this.$("#bottom .add").hidden = selecting;
    for (const sw of document.querySelectorAll(".swatch")) sw.hidden = !cards.length;
    const one = cards.length === 1 && !lanes.length ? cards[0] : null;
    this.$('[data-act="turn"]').hidden = !one;
    this.$('[data-act="pile"]').hidden = !(one && R.laneOf(app.model.board, one.id, app.heightOf));
    this.$("#keys").hidden = !s.editing;
    for (const m of document.querySelectorAll('[data-act="mode"]')) m.setAttribute("aria-pressed", String(m.dataset.mode === this.mode));
    this.place();
    this.updateZoom();
  }

  updateZoom() {
    this.$('[data-act="zoom"]').textContent = `${Math.round(this.app.view.cam.zoom * 100)} %`;
  }

  /** Puts the keyboard bar on the keyboard, wherever iOS has moved the visual viewport. */
  place() {
    const vv = visualViewport;
    this.$("#keys").style.top = `${vv.offsetTop + vv.height - KEYS_H}px`;
  }

  /** The part of the screen the board shows through, between the bars and above the keyboard. */
  area() {
    const vv = visualViewport;
    const above = this.$("#find").hidden ? this.$("#top") : this.$("#find");
    const keyboard = vv.height < innerHeight - 100;
    const bottom = keyboard
      ? vv.offsetTop + vv.height - (this.app.state.editing ? KEYS_H : 0)
      : this.$("#bottom").getBoundingClientRect().top;
    return { top: above.getBoundingClientRect().bottom, bottom, left: 0, right: innerWidth };
  }

  closeMenu() {
    this.$(".menu").hidden = true;
  }

  openSettings() {
    this.$("#settings").hidden = false;
    this.update();
  }

  openFind() {
    this.$("#find").hidden = false;
    const field = this.$("#find input");
    field.focus();
    field.select();
    this.find(field.value);
  }

  closeFind() {
    this.$("#find").hidden = true;
    this.$("#find input").blur();
    this.matches = [];
    this.app.state.found = null;
    this.app.view.invalidate();
  }

  find(q) {
    this.matches = R.search(this.app.model.board, q);
    this.index = -1;
    this.$("#find .count").textContent = q.trim() ? "0" : "";
    if (this.matches.length) return this.step(1);
    this.app.state.found = null;
    this.app.view.invalidate();
  }

  step(d) {
    const n = this.matches.length;
    if (!n) return;
    this.index = (this.index + d + n) % n;
    this.$("#find .count").textContent = `${this.index + 1}/${n}`;
    this.app.reveal(this.matches[this.index]);
  }
}
