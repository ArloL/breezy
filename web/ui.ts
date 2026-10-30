import * as R from "./rules.ts";
import { track } from "./press.ts";
import { Menus } from "./menu.ts";
import { haptic } from "./haptics.ts";
import { animate } from "./motion.ts";
import { clampZoom } from "./view.ts";
import { composingKey } from "./ime.ts";
import { clipHTML, clipText, readClip } from "./clip.ts";
import type { App, Match } from "./app.ts";
import type { Clip } from "./types.ts";

const KEYS_H = 44;
const MENUS: Partial<Record<string, string>> = { add: ".add .menu", more: ".menu.more", colours: ".colours .menu" };
const BAR = { type: "spring", visualDuration: 0.35, bounce: 0.15 };
const REST: Record<string, string | number> = { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)" };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shows or hides `el` the way iOS bars come and go: springing in from `from`, and out again before hiding. */
function swap(el: HTMLElement, show: boolean, from: Record<string, string | number>) {
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
  app: App;
  matches: Match[];
  index: number;
  $: <E extends HTMLElement = HTMLElement>(sel: string) => E;
  menus: Menus;
  zoom: number | undefined;
  zoomTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(app: App) {
    this.app = app;
    this.matches = [];
    this.index = -1;
    this.$ = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
    this.menus = new Menus({ pick: (b) => (haptic(), this.act(b.dataset.act, b)), hover: haptic });
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-act]")) {
      const menu = MENUS[b.dataset.act!];
      if (menu) this.menus.attach(b, this.$(menu));
      track(b, { act: () => menu || this.act(b.dataset.act, b) });
    }
    const field = this.$<HTMLInputElement>("#find input");
    field.addEventListener("input", () => {
      this.$("#find .clear").hidden = !field.value;
      this.find(field.value);
    });
    field.addEventListener("keydown", (e) => {
      if (composingKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return this.closeFind();
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.step(1);
    });
    visualViewport!.addEventListener("resize", () => {
      this.place();
      this.app.revealEditing();
      // the keyboard coming or going moves the middle of what is visible
      if (!this.$("#find").hidden && this.matches[this.index]) this.app.reveal(this.matches[this.index]);
    });
    // iOS moves the visual viewport as the keyboard comes, at times with no resize after: what shows changed
    visualViewport!.addEventListener("scroll", () => {
      this.place();
      this.app.revealEditing();
    });
    // the caret moved by keys or a click, which the board keeps in sight as it does typing
    document.addEventListener("selectionchange", () => this.app.revealEditing());
    this.update();
  }

  /** The ⋯ menu's status: the open board's space, and whether boards can be saved. */
  updateSync() {
    const lib = this.app.library;
    if (!lib) return;
    const status = this.$(".menu.more .status");
    const text = lib.statusLines().join("\n");
    if (text === status.textContent) return;
    status.textContent = text;
    status.hidden = !text;
  }

  act(name: string | undefined, b?: HTMLElement) {
    const app = this.app;
    switch (name) {
      case "boards": return app.library?.showList();
      case "undo": return app.undo();
      case "redo": return app.redo();
      case "search": return this.openFind();
      case "version": b!.textContent = b!.dataset.next ? `${b!.dataset.version}, ${b!.dataset.next} ready` : b!.dataset.version!; return;
      case "new-space": this.closeMenu(); return app.library?.newSpace();
      case "rename-space": this.closeMenu(); return app.library?.renameSpace();
      case "leave-space": this.closeMenu(); return app.library?.leaveSpace();
      case "join": this.closeMenu(); return app.library?.join();
      case "your-name": this.closeMenu(); return app.library?.askName();
      case "report": this.closeMenu(); return app.library?.reportProblem();
      case "share": this.closeMenu(); return app.library?.share();
      case "new-card": this.closeMenu(); return app.newCard(app.view.toWorld(app.view.centre()));
      case "new-lane": this.closeMenu(); return app.newLane();
      case "paste": this.closeMenu(); return void this.paste();
      case "colour": this.closeMenu(); return app.colour(Number(b!.dataset.colour));
      case "turn": {
        const [c] = app.selectedCards();
        return c && app.turn(app.state.turned === c.id ? null : c.id);
      }
      case "copy": return this.copy();
      case "delete": return app.removeSelection();
      case "key-turn": return app.switchSide();
      case "key-done": return app.endEditing();
      case "prev": return this.step(-1);
      case "next": return this.step(1);
      case "close-find": return this.closeFind();
      case "clear-find": {
        const field = this.$<HTMLInputElement>("#find input");
        field.value = "";
        b!.hidden = true;
        field.focus();
        return this.find("");
      }
    }
  }

  /** The selected cards to the clipboard, written within the tap, as Safari and Chrome on a phone want. */
  copy() {
    const clip = this.app.copySelection();
    if (!clip) return;
    const blob = (type: string, text: string) => new Blob([text], { type });
    const refused = (e: Error) => this.app.flight.note("decision", "copy refused", { why: e.name });
    try {
      navigator.clipboard.write([new ClipboardItem({ "text/html": blob("text/html", clipHTML(clip)), "text/plain": blob("text/plain", clipText(clip)) })]).catch(refused);
    } catch (e) {
      refused(e as Error);
    }
  }

  /** The clipboard's cards, read from the tap, which iOS asks to Paste; else what this page last copied, if anything. */
  async paste() {
    const app = this.app;
    let clip: Clip | null = null, why = "no cards";
    try {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes("text/html") && (clip = readClip(await (await item.getType("text/html")).text()))) break;
      }
    } catch (e) {
      why = (e as Error).name;
    }
    app.flight.note("decision", "paste source", clip ? { from: "clipboard" } : { from: "page", why, copied: !!app.copied });
    clip ??= app.copied;
    if (clip) app.paste(clip);
  }

  update() {
    const app = this.app;
    const s = app.state;
    const cards = app.selectedCards();
    const lanes = app.selectedLanes();
    const typing = !!(s.editing || s.renaming);
    this.$<HTMLButtonElement>('[data-act="undo"]').disabled = !(app.model.canUndo || app.model.inGesture);
    this.$<HTMLButtonElement>('[data-act="redo"]').disabled = !app.model.canRedo;
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
    for (const b of document.querySelectorAll<HTMLElement>(".colours .menu button")) b.classList.toggle("on", Number(b.dataset.colour) === cards[0]?.color);
    if (!selecting && this.menus.menu === this.$(".colours .menu")) this.menus.close(true);
    const one = cards.length === 1 && !lanes.length ? cards[0] : null;
    this.$('[data-act="turn"]').hidden = !one;
    this.$('[data-act="copy"]').hidden = !cards.length;
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

  /** Puts the keyboard bar on the keyboard, the bars at the top of the screen at its top, and a sheet in what shows
   * above the keyboard, wherever iOS has moved the visual viewport: as the keyboard came, iOS scrolled the page, and the
   * top bar went off the screen with it; centred in the layout, Chrome on Android left a sheet's OK under the keyboard. */
  place() {
    const vv = visualViewport!;
    this.$("#keys").style.top = `${vv.offsetTop + vv.height - KEYS_H}px`;
    document.body.style.setProperty("--screen-top", `${vv.offsetTop}px`);
    Object.assign(this.$("#sheet").style, { top: `${vv.offsetTop}px`, height: `${vv.height}px`, bottom: "auto" });
  }

  /** The part of the screen the board shows through: below the bars, above the keyboard, the keys bar and the bottom bar. */
  area() {
    const vv = visualViewport!;
    const above = this.$("#find").hidden ? this.$("#top") : this.$("#find");
    const bar = this.$("#bottom");
    // in the board's own frame, which the camera works in: with the keyboard up iOS scrolled the page, and the board,
    // fixed, went up with it in the page's coordinates, where the bars' rects and the screen are
    const origin = this.$("#board").getBoundingClientRect().top;
    const top = vv.pageTop - scrollY - origin;
    const visible = top + vv.height - (this.app.state.editing ? KEYS_H : 0);
    const bottom = bar.hidden ? visible : Math.min(visible, bar.getBoundingClientRect().top - origin);
    return { top: Math.max(above.getBoundingClientRect().bottom - origin, top), bottom, left: 0, right: innerWidth };
  }

  /** A light tap where the device has a Taptic Engine. */
  haptic() {
    haptic();
  }

  closeMenu() {
    this.menus.close();
    this.$('[data-act="version"]').textContent = "Version";
  }

  /** Opens the find bar, with `text` to find if given. */
  openFind(text?: string) {
    this.closeMenu();
    swap(this.$("#find"), true, { y: -24, opacity: 0, scale: 0.96 });
    const field = this.$<HTMLInputElement>("#find input");
    if (text !== undefined) {
      field.value = text;
      this.$("#find .clear").hidden = !text;
    }
    field.focus();
    field.select();
    this.find(field.value);
  }

  /** ⌘G: the next match, opening the bar on the last search when it is closed. */
  findStep(d: number) {
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

  find(q: string) {
    this.matches = R.search(this.app.model.board, q);
    this.index = -1;
    this.$("#find .count").textContent = q.trim() ? "0" : "";
    if (this.matches.length) return this.step(1);
    this.app.state.found = null;
    this.app.view.invalidate();
  }

  step(d: number) {
    const n = this.matches.length;
    if (!n) return;
    this.index = (this.index + d + n) % n;
    this.$("#find .count").textContent = `${this.index + 1}/${n}`;
    this.app.reveal(this.matches[this.index]);
  }
}
