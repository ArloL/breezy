import { initials } from "./sync/live.js";

const ARROW = '<svg viewBox="0 0 16 16"><path d="M2 1.5 13.5 8 8.2 9.2 5.6 14.5Z"/></svg>';

/** A person's initials in their colour, as the top bar and the board list show them. */
export function chip(person) {
  const s = document.createElement("span");
  s.className = "person";
  s.style.setProperty("--who", person.colour);
  s.textContent = initials(person.name);
  s.title = person.name;
  return s;
}

/**
 * Others over the board: their cursors with names, in screen points so that they keep their size at any zoom, and the
 * row of initials in the top bar.
 */
export class Presence {
  constructor(view) {
    this.view = view;
    this.layer = document.querySelector("#board .presence");
    this.row = document.querySelector("#top .people");
    this.els = new Map();
    this.cursors = [];
    this.carets = [];
  }

  /** `cursors`: [{ key, person, x, y }] in world points; `carets`: [{ key, person, id, back, at }]; `people`: who else is on the board. */
  show({ cursors, carets = [], people }) {
    this.cursors = cursors;
    this.carets = carets;
    const key = people.map((p) => `${p.device} ${p.name}`).join("\n");
    if (key !== this.people) {
      this.people = key;
      this.row.hidden = !people.length;
      this.row.replaceChildren(...people.map(chip));
    }
    this.place();
  }

  /** After every render and camera move. */
  place() {
    const live = new Set();
    for (const c of this.cursors) {
      live.add(c.key);
      const el = this.element(c.key, "cursor", `${ARROW}<span></span>`);
      el.style.setProperty("--who", c.person.colour);
      el.lastChild.textContent = c.person.name;
      const p = this.view.toScreen(c);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    for (const c of this.carets) {
      const r = this.view.caretRect(c.id, c.back, c.at);
      if (!r) continue;
      const key = `caret:${c.key}`;
      live.add(key);
      const el = this.element(key, "caret", "");
      el.style.setProperty("--who", c.person.colour);
      el.style.transform = `translate(${r.x}px, ${r.y}px)`;
      el.style.height = `${r.h}px`;
    }
    for (const [key, el] of this.els) {
      if (live.has(key)) continue;
      el.remove();
      this.els.delete(key);
    }
  }

  element(key, cls, html) {
    let el = this.els.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = cls;
      el.innerHTML = html;
      this.layer.append(el);
      this.els.set(key, el);
    }
    return el;
  }
}
