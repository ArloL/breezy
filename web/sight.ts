// Whether the card being edited is in sight, as a person sees it: what the board shows of the screen, the edited card
// and its caret, read from the page (readSight), and what is wrong with that (outOfSight). The scenarios check it
// after every step (scenarios/sight.ts, B1 in TESTING.md), and the app on its own once the board stands still.
import type { Rect } from "./types.ts";

/** What the board shows of the screen, the edited card and its caret, in screen points: for a scenario to check the card
 * is in sight. */
export interface Sight {
  focus: Rect | null;
  caret: Rect | null;
  visible: Rect;
  /** On a real device, the bar at the top of the screen, the find bar's or the top bar's, and the screen: iOS scrolled
   * the page under the keyboard, and the top bar with it. */
  bar?: Rect | null;
  screen?: Rect;
  /** How a real device read `visible`, for a failure to explain itself. */
  how?: string;
}

const inside = (a: Rect, b: Rect) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
/** Whether the app shows `a` whole in `b`: within 16 pt of each edge, else only the caret's line (app.ts, revealEditing). */
const fits = (a: Rect, b: Rect) => a.w + 32 <= b.w + 1 && a.h + 32 <= b.h + 1;
const say = (b: Rect | null) => b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}` : "none";

/** What is wrong with `s`, or null: the edited card shows whole, or of one too big to, its caret does, and the bar at
 * the top of the screen shows. */
export function outOfSight(s: Sight): string | null {
  const { focus, caret, visible, bar, screen } = s;
  if (!focus) return null;
  if (bar && screen && bar.y < screen.y - 1) return `the top bar at ${say(bar)}, above the screen at ${say(screen)}${s.how ? ` (${s.how})` : ""}`;
  if (fits(focus, visible) ? inside(focus, visible) : caret && inside(caret, visible)) return null;
  return `the edited card at ${say(focus)}, its caret at ${say(caret)}, the board showing ${say(visible)}${s.how ? ` (${s.how})` : ""}`;
}

/**
 * What the sight check needs of the editor, and no more: the card being edited, its caret and what of the screen shows
 * the board, as readEditor reads them, without a box for each character, which made each key's check cost 120 ms on a
 * runner. Null when nothing is edited. Runs in the page.
 */
export function readSight(): Sight | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.isContentEditable) return null;
  const box = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  const card = el.closest(".cards > [data-id]")?.getBoundingClientRect();
  const sel = getSelection();
  const range = sel?.rangeCount && el.contains(sel.focusNode) ? sel.getRangeAt(0) : null;
  let at = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
  // a caret between an element's children, as Chrome on Android leaves it after a card's last text, has no box of its
  // own: the same place in the text beside it has
  if (!at?.height && range?.collapsed) {
    let [node, offset] = [range.startContainer, range.startOffset];
    if (node instanceof Element) {
      const before = node.childNodes[offset - 1], after = node.childNodes[offset];
      [node, offset] = before instanceof Text ? [before, before.length] : after instanceof Text ? [after, 0] : [node, offset];
    }
    // nor has one on an empty line, between two newlines: the newline after it is on that line, the one before it
    // ends the line above
    if (node instanceof Text) {
      const box = (from: number, to: number) => {
        if (from < 0 || to > node.length) return undefined;
        const r = document.createRange();
        r.setStart(node, from);
        r.setEnd(node, to);
        const b = r.getClientRects()[0];
        return b?.height ? b : undefined;
      };
      const next = box(offset, offset + 1), prev = box(offset - 1, offset);
      at = next ? new DOMRect(next.x, next.y, 0, next.height) : prev && node.data[offset - 1] === "\n" ? new DOMRect(prev.x, prev.bottom, 0, prev.height) : prev ? new DOMRect(prev.right, prev.y, 0, prev.height) : at;
    }
  }
  // nor has a caret in an empty editor, as the back of a card just turned: it is where the text would start, a line high
  if (!at?.height && range?.collapsed && !el.textContent) {
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el), z = el.offsetHeight ? b.height / el.offsetHeight : 1;
    at = new DOMRect(b.left + Number.parseFloat(cs.paddingLeft) * z, b.top + Number.parseFloat(cs.paddingTop) * z, 0, (Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2) * z);
  }
  const v = visualViewport!;
  const bar = (q: string) => {
    const b = document.querySelector<HTMLElement>(q);
    return b && !b.hidden && b.getClientRects().length ? b.getBoundingClientRect() : null;
  };
  const above = bar("#find") ?? bar("#top"), below = [bar("#keys"), bar("#bottom")].filter((b) => b !== null);
  const pin = document.createElement("div");
  pin.style.cssText = "position:fixed;top:0;left:0;width:0;height:0";
  document.body.append(pin);
  const layout = pin.getBoundingClientRect();
  pin.remove();
  const vx = layout.left + v.offsetLeft, vy = layout.top + v.offsetTop;
  const top = Math.max(vy, above?.bottom ?? -Infinity), bottom = Math.min(vy + v.height, ...below.map((b) => b.top));
  return {
    focus: card ? box(card) : null,
    caret: at?.height ? { x: at.x, y: at.y, w: 0, h: at.height } : null,
    visible: { x: vx, y: top, w: v.width, h: bottom - top },
    bar: above && box(above),
    screen: { x: vx, y: vy, w: v.width, h: v.height },
    how: `visual viewport ${Math.round(vy)}+${Math.round(v.height)} in ${innerHeight}, layout from ${Math.round(layout.top)}, above ${above ? Math.round(above.bottom) : "none"}, below ${below.map((b) => Math.round(b.top)).join(" ") || "none"}`,
  };
}


/** Checks that the card being edited is in sight once nothing has moved what shows for `quietMs`, as a person sees it
 * once the board stops: each change `poke`s it, and a camera still moving puts the check off. What it finds wrong is
 * `broken`, once until the card was in sight again. */
export class SightWatch {
  private readonly read: () => Sight | null;
  private readonly moving: () => boolean;
  private readonly broken: (problem: string, s: Sight) => void;
  private readonly quietMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last: string | null = null;

  constructor({ read, moving, broken, quietMs = 700 }: { read: () => Sight | null; moving: () => boolean; broken: (problem: string, s: Sight) => void; quietMs?: number }) {
    this.read = read;
    this.moving = moving;
    this.broken = broken;
    this.quietMs = quietMs;
  }

  poke() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), this.quietMs);
  }

  /** Its user moved the board, by a pan, a pinch or a wheel: a card they moved out of sight is theirs to bring back. */
  moved() {
    this.away = true;
  }

  /** Its user edited, which the board keeps in sight again. */
  edited() {
    this.away = false;
    this.poke();
  }

  private away = false;

  private check() {
    if (this.away) return;
    if (this.moving()) return this.poke();
    let s: Sight | null = null;
    try {
      s = this.read();
    } catch {}
    const problem = s && outOfSight(s);
    if (problem && !this.last) this.broken(problem, s!);
    this.last = problem;
  }
}
