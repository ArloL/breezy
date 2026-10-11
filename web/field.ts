import type { Field, FieldEvents } from "./ports.ts";

function caretToEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

/**
 * Firefox draws an empty last line with a <br> after the newline, and the caret before that <br> at the end of the
 * line above. A second newline, as Chrome uses, draws the line; the caret goes at the start of its own text node, as
 * at the end of a text node it is drawn at the end of the line above.
 */
function newlineForBreak(el: HTMLElement) {
  const br = el.lastChild;
  if (br?.nodeName !== "BR") return;
  const sel = getSelection()!;
  const atEnd = sel.anchorNode === el && sel.anchorOffset >= el.childNodes.length - 1;
  const nl = document.createTextNode("\n");
  br.replaceWith(nl);
  if (atEnd) sel.collapse(nl, 0);
}

/**
 * Draws a card's front: its first line, the title, in a span of its own, so that it stays bold where it wraps, which
 * ::first-line does not; the rest, from the newline on, in a text node after it.
 */
export function fillFront(el: HTMLElement, text: string) {
  const nl = text.indexOf("\n");
  const head = document.createElement("span");
  head.className = "headline";
  head.textContent = nl < 0 ? text : text.slice(0, nl);
  el.replaceChildren(head);
  if (nl >= 0) el.append(text.slice(nl));
}

/** Where offset `at` of a front that fillFront drew falls, ending the title rather than starting the rest. */
export function frontPoint(el: HTMLElement, at: number): [Node, number] {
  const [head, rest] = el.childNodes;
  if (!head) return [el, 0];
  const title = head.firstChild as Text | null;
  const n = title?.length ?? 0;
  if (at <= n || !(rest instanceof Text)) return title ? [title, Math.min(at, n)] : [head, 0];
  return [rest, Math.min(at - n, rest.length)];
}

function isDrawn(el: HTMLElement) {
  const [head, rest, ...more] = el.childNodes;
  if (!(head instanceof HTMLSpanElement) || head.className !== "headline" || more.length) return false;
  const [title, ...split] = head.childNodes;
  return !split.length && (!title || title instanceof Text && !title.data.includes("\n"))
    && (!rest || rest instanceof Text && rest.data.startsWith("\n"));
}

/** The text of `n` as drawn, a <br> as the newline it draws. */
function plain(n: Node): string {
  if (n instanceof Text) return n.data;
  if (n.nodeName === "BR") return "\n";
  return [...n.childNodes].map(plain).join("");
}

/**
 * Draws the front again as fillFront does when an edit has put a newline in the title, text before it or a <br> in
 * it, as Return, joining two lines or typing into an empty card do; the caret stays where it was in the text.
 */
function redrawFront(el: HTMLElement) {
  if (isDrawn(el)) return;
  const sel = getSelection()!;
  let at: number | null = null;
  if (sel.rangeCount && el.contains(sel.focusNode)) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(sel.focusNode!, sel.focusOffset);
    at = plain(r.cloneContents()).length;
  }
  fillFront(el, plain(el));
  if (at !== null) sel.collapse(...frontPoint(el, at));
}

/** A card side's text or a lane's title, edited in place as plain text. */
export class DomField implements Field {
  el: HTMLElement;
  /** A card's front, whose first line is its title; its notes; or a lane's title, which Return ends. */
  kind: "front" | "notes" | "title";
  /** Redraws a front once an input method is done with it. */
  composed: () => void;

  constructor(el: HTMLElement, kind: "front" | "notes" | "title") {
    this.el = el;
    this.kind = kind;
    this.composed = () => redrawFront(el);
  }

  /** Focus stays synchronous, so that iOS shows the keyboard. */
  open(text: string, on: FieldEvents) {
    const el = this.el;
    if (this.kind === "front") fillFront(el, text);
    else el.textContent = text;
    el.classList.remove("placeholder");
    el.contentEditable = "plaintext-only";
    el.oninput = (ev) => {
      // An input method's text is redrawn once it is done with it.
      if (this.kind === "front" && !(ev as InputEvent).isComposing) redrawFront(el);
      on.input();
    };
    if (this.kind === "front") el.addEventListener("compositionend", this.composed);
    el.onblur = () => on.done();
    if (on.enter) {
      const enter = on.enter;
      el.onkeydown = (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        enter();
      };
    }
    el.focus({ preventScroll: true });
    caretToEnd(el);
  }

  text() {
    if (this.kind === "title") return this.el.textContent;
    if (this.kind === "notes") newlineForBreak(this.el);
    // An empty last line is drawn from two newlines; the last one is not part of the text.
    const raw = this.el.innerText.replace(/​/g, "");
    return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  }

  caret() {
    const sel = getSelection()!;
    if (!sel.rangeCount || !this.el.contains(sel.focusNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(this.el);
    r.setEnd(sel.focusNode!, sel.focusOffset);
    return r.toString().replace(/​/g, "").length;
  }

  detach() {
    this.el.onblur = this.el.oninput = this.el.onkeydown = null;
    this.el.removeEventListener("compositionend", this.composed);
  }

  close() {
    this.detach();
    this.el.blur();
    this.el.contentEditable = "false";
  }
}
