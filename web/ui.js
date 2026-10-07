import * as R from "./rules.js";
import { track } from "./press.js";
import { Menus } from "./menu.js";

const KEYS_H = 44;
const MENUS = { add: ".add .menu", more: ".menu.more", colours: ".colours .menu" };

/** The bars around the board: top, find, add and selection, and keyboard. */
export class UI {
  constructor(app) {
    this.app = app;
    this.matches = [];
    this.index = -1;
    this.$ = (sel) => document.querySelector(sel);
    this.menus = new Menus({ pick: (b) => this.act(b.dataset.act, b) });
    for (const b of document.querySelectorAll("[data-act]")) {
      const menu = MENUS[b.dataset.act];
      if (menu) this.menus.attach(b, this.$(menu));
      track(b, { act: () => menu || this.act(b.dataset.act, b) });
    }
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
      case "version": b.textContent = b.dataset.version; return;
      case "new-card": this.closeMenu(); return app.newCard(app.view.toWorld(app.view.centre()));
      case "new-lane": this.closeMenu(); return app.newLane();
      case "colour": this.closeMenu(); return app.colour(Number(b.dataset.colour));
      case "turn": {
        const [c] = app.selectedCards();
        return c && app.turn(app.state.turned === c.id ? null : c.id);
      }
      case "delete": return app.removeSelection();
      case "key-turn": return app.switchSide();
      case "key-done": return app.endEditing();
      case "prev": return this.step(-1);
      case "next": return this.step(1);
      case "close-find": return this.closeFind();
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
    this.$(".colours").hidden = !cards.length;
    if (cards.length) this.$(".colours .swatch i").className = `c${cards[0].color}`;
    for (const b of document.querySelectorAll(".colours .menu button")) b.classList.toggle("on", Number(b.dataset.colour) === cards[0]?.color);
    if (!selecting && this.menus.menu === this.$(".colours .menu")) this.menus.close(true);
    const one = cards.length === 1 && !lanes.length ? cards[0] : null;
    this.$('[data-act="turn"]').hidden = !one;
    this.$("#keys").hidden = !s.editing;
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

  /** The part of the screen the board shows through: below the bars, above the keyboard, the keys bar and the bottom bar. */
  area() {
    const vv = visualViewport;
    const above = this.$("#find").hidden ? this.$("#top") : this.$("#find");
    const bar = this.$("#bottom");
    const visible = vv.offsetTop + vv.height - (this.app.state.editing ? KEYS_H : 0);
    const bottom = bar.hidden ? visible : Math.min(visible, bar.getBoundingClientRect().top);
    return { top: Math.max(above.getBoundingClientRect().bottom, vv.offsetTop), bottom, left: 0, right: innerWidth };
  }

  closeMenu() {
    this.menus.close();
    this.$('[data-act="version"]').textContent = "Version";
  }

  openFind() {
    this.closeMenu();
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
