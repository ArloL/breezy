import { animate } from "./motion.js";

const OPEN = { type: "spring", visualDuration: 0.35, bounce: 0.2 };
const CLOSE = { type: "spring", visualDuration: 0.22, bounce: 0 };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Pull-down menus as UIKit has them: a menu opens on touch-down and grows out of its button; the finger that opened
 * it can slide onto an item and lift to pick it; a tap anywhere outside only closes it. `pick(item)` runs an item;
 * `hover(item)` hears each item the finger slides onto.
 */
export class Menus {
  constructor({ pick, hover = () => {} }) {
    this.pick = pick;
    this.hover = hover;
    this.menu = null;
    this.opener = null;
    this.hot = null;
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.menu || this.menu.contains(e.target) || this.opener?.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
      },
      true,
    );
  }

  /** Wires `opener` to open `menu` on touch-down and to pick by sliding while that finger stays down. */
  attach(opener, menu) {
    let sliding = null;
    opener.addEventListener("pointerdown", (e) => {
      if (opener.disabled) return;
      if (this.menu === menu) return this.close();
      this.open(opener, menu);
      sliding = e.pointerId;
    });
    opener.addEventListener("pointermove", (e) => {
      if (e.pointerId === sliding) this.slide(e.clientX, e.clientY);
    });
    const end = (e) => {
      if (e.pointerId !== sliding) return;
      sliding = null;
      const item = this.hot;
      this.highlight(null);
      if (item && e.type === "pointerup") this.pick(item);
    };
    opener.addEventListener("pointerup", end);
    opener.addEventListener("pointercancel", end);
  }

  open(opener, menu) {
    this.close(true);
    this.menu = menu;
    this.opener = opener;
    menu.hidden = false;
    if (!reduced()) animate(menu, { scale: [0.35, 1], opacity: [0, 1], filter: ["blur(10px)", "blur(0px)"] }, OPEN);
  }

  /** Closes the open menu, shrinking it back into its button unless `now`. */
  close(now = false) {
    const m = this.menu;
    if (!m) return;
    this.menu = this.opener = null;
    this.highlight(null);
    if (now || reduced()) {
      m.hidden = true;
      return;
    }
    animate(m, { scale: 0.35, opacity: 0, filter: "blur(10px)" }, CLOSE).then(() => {
      if (this.menu !== m) m.hidden = true;
    });
  }

  slide(x, y) {
    const b = document.elementFromPoint(x, y)?.closest("button");
    this.highlight(b && this.menu?.contains(b) ? b : null);
  }

  highlight(item) {
    if (item === this.hot) return;
    this.hot?.classList.remove("hot");
    item?.classList.add("hot");
    this.hot = item;
    if (item) this.hover(item);
  }
}
