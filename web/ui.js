import * as R from "./rules.js";
import { track } from "./press.js";
import { Menus } from "./menu.js";
import { haptic } from "./haptics.js";
import { animate } from "./motion.js";
import { clampZoom } from "./view.js";

const KEYS_H = 44;
const MENUS = { add: ".add .menu", more: ".menu.more", colours: ".colours .menu" };
const BAR = { type: "spring", visualDuration: 0.35, bounce: 0.15 };
const REST = { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)" };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shows or hides `el` the way iOS bars come and go: springing in from `from`, and out again before hiding. */
function swap(el, show, from) {
  if (show === !el.hidden && !el.dataset.leaving) return;
  if (reduced()) {
    el.hidden = !show;
    return;
  }
  if (show) {
    delete el.dataset.leaving;
    el.hidden = false;
    animate(el, Object.fromEntries(Object.entries(from).map(([k, v]) => [k, [v, REST[k]]])), BAR);
  } else {
    el.dataset.leaving = "1";
    animate(el, from, { ...BAR, visualDuration: 0.25, bounce: 0 }).then(() => {
      if (!el.dataset.leaving) return;
      delete el.dataset.leaving;
      el.hidden = true;
    });
  }
}

/** The bars around the board: top, find, add and selection, and keyboard. */
export class UI {
  constructor(app) {
    this.app = app;
    this.matches = [];
    this.index = -1;
    this.$ = (sel) => document.querySelector(sel);
    this.menus = new Menus({ pick: (b) => (haptic(), this.act(b.dataset.act, b)), hover: haptic });
    for (const b of document.querySelectorAll("[data-act]")) {
      const menu = MENUS[b.dataset.act];
      if (menu) this.menus.attach(b, this.$(menu));
      track(b, { act: () => menu || this.act(b.dataset.act, b) });
    }
    const field = this.$("#find input");
    field.addEventListener("input", () => {
      this.$("#find .clear").hidden = !field.value;
      this.find(field.value);
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return this.closeFind();
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.step(1);
    });
    visualViewport.addEventListener("resize", () => {
      this.place();
      this.app.revealEditing();
      // the keyboard coming or going moves the middle of what is visible
      if (!this.$("#find").hidden && this.matches[this.index]) this.app.reveal(this.matches[this.index]);
    });
    visualViewport.addEventListener("scroll", () => this.place());
    this.update();
  }

  /** The ⋯ menu's sync status and the actions that fit it. */
  updateSync() {
    const lib = this.app.library;
    if (!lib) return;
    this.$(".menu.more .status").textContent = lib.statusLines().join("\n");
    this.$('[data-act="start-sync"]').hidden = lib.store.syncing;
    this.$('[data-act="share"]').hidden = !lib.store.syncing;
  }

  act(name, b) {
    const app = this.app;
    switch (name) {
      case "boards": return app.library?.showList();
      case "new-board": return app.library?.newBoard();
      case "undo": return app.undo();
      case "redo": return app.redo();
      case "search": return this.openFind();
      case "version": b.textContent = b.dataset.next ? `${b.dataset.version}, ${b.dataset.next} ready` : b.dataset.version; return;
      case "start-sync": this.closeMenu(); return app.library?.startSyncing();
      case "join": this.closeMenu(); return app.library?.join();
      case "share": this.closeMenu(); return app.library?.share();
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
      case "clear-find": {
        const field = this.$("#find input");
        field.value = "";
        b.hidden = true;
        field.focus();
        return this.find("");
      }
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
    swap(this.$("#bottom"), !typing, { y: 120, opacity: 0 });
    const selecting = cards.length + lanes.length > 0;
    // The + and the selection bar morph into one another, as iOS 26's glass does.
    const morph = { scale: 0.6, opacity: 0, filter: "blur(6px)" };
    if (selecting) {
      this.$("#bottom .add").hidden = true;
      swap(this.$("#bottom .selection"), true, morph);
    } else {
      this.$("#bottom .selection").hidden = true;
      swap(this.$("#bottom .add"), true, morph);
    }
    this.$(".colours").hidden = !cards.length;
    if (cards.length) this.$(".colours .swatch i").className = `c${cards[0].color}`;
    for (const b of document.querySelectorAll(".colours .menu button")) b.classList.toggle("on", Number(b.dataset.colour) === cards[0]?.color);
    if (!selecting && this.menus.menu === this.$(".colours .menu")) this.menus.close(true);
    const one = cards.length === 1 && !lanes.length ? cards[0] : null;
    this.$('[data-act="turn"]').hidden = !one;
    this.$("#keys").hidden = !s.editing;
    this.place();
  }

  /** While the zoom changes, a small capsule shows it, fading a second after it stops, as in Freeform. */
  updateZoom() {
    const z = Math.round(clampZoom(this.app.view.cam.zoom) * 100);
    if (z === this.zoom) return;
    const first = this.zoom === undefined;
    this.zoom = z;
    if (first) return;
    const level = this.$("#zoom-level");
    level.textContent = `${z} %`;
    swap(level, true, { opacity: 0, scale: 0.9 });
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => swap(level, false, { opacity: 0, scale: 0.9 }), 1000);
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

  /** Opens the find bar, with `text` to find if given. */
  openFind(text) {
    this.closeMenu();
    swap(this.$("#find"), true, { y: -24, opacity: 0, scale: 0.96 });
    const field = this.$("#find input");
    if (text !== undefined) {
      field.value = text;
      this.$("#find .clear").hidden = !text;
    }
    field.focus();
    field.select();
    this.find(field.value);
  }

  /** ⌘G: the next match, opening the bar on the last search when it is closed. */
  findStep(d) {
    if (this.$("#find").hidden) return this.openFind();
    this.step(d);
  }

  closeFind() {
    swap(this.$("#find"), false, { y: -24, opacity: 0, scale: 0.96 });
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
