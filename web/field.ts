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
 * at the end of a text node it is drawn at the end of the title's ::first-line.
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

/** A card side's text or a lane's title, edited in place as plain text. */
export class DomField implements Field {
  el: HTMLElement;
  /** A card's text, which may span lines, or a lane's title, which Return ends. */
  kind: "card" | "title";

  constructor(el: HTMLElement, kind: "card" | "title") {
    this.el = el;
    this.kind = kind;
  }

  /** Focus stays synchronous, so that iOS shows the keyboard. */
  open(text: string, on: FieldEvents) {
    const el = this.el;
    el.textContent = text;
    el.classList.remove("placeholder");
    el.contentEditable = "plaintext-only";
    el.oninput = () => on.input();
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
    newlineForBreak(this.el);
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
  }

  close() {
    this.detach();
    this.el.blur();
    this.el.contentEditable = "false";
  }
}
