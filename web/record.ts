/**
 * Records what a platform's input did to the editor, as a trace that scenarios/platform/replay.test.ts replays: see
 * docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md. Loaded only with ?record.
 */
export type Kind = "front" | "notes" | "title";

export interface EditorState {
  text: string;
  /** The caret's offset in `text`. */
  at: number;
  kind: Kind | null;
  editing: boolean;
}

export type Step =
  | { t: number; type: "keydown" | "keyup"; key: string; code: string; isComposing: boolean; keyCode: number; mods: string }
  | { t: number; type: "compositionstart" | "compositionupdate" | "compositionend"; data: string }
  | { t: number; type: "beforeinput" | "input"; inputType: string; data: string | null; isComposing: boolean; range: [number, number] | null }
  | { t: number; type: "focus" | "blur"; of: "editor" | "window"; hasFocus: boolean }
  | { t: number; type: "selection"; range: [number, number] };

export interface Trace {
  row: string;
  variant: string;
  target: string;
  source: "native" | "phone" | "manual";
  ua: string;
  /** The keyboard or input source, as the person or driver names it. */
  keyboard: string;
  before: EditorState;
  steps: Step[];
  after: EditorState;
}

/** What `toStep` reads of an event, so that it runs without a DOM. */
export interface EventFields {
  type: string;
  target: "editor" | "window";
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  data?: string | null;
  inputType?: string;
}

export function toStep(e: EventFields, t: number, range: [number, number] | null, hasFocus: boolean): Step | null {
  t = Math.round(t);
  switch (e.type) {
    case "keydown":
    case "keyup": {
      const mods = (["meta", "ctrl", "alt", "shift"] as const).filter((m) => e[`${m}Key`]).join("+");
      return { t, type: e.type, key: e.key ?? "", code: e.code ?? "", isComposing: !!e.isComposing, keyCode: e.keyCode ?? 0, mods };
    }
    case "compositionstart":
    case "compositionupdate":
    case "compositionend":
      return { t, type: e.type, data: e.data ?? "" };
    case "beforeinput":
    case "input":
      return { t, type: e.type, inputType: e.inputType ?? "", data: e.data ?? null, isComposing: !!e.isComposing, range };
    case "focusin":
    case "focus":
      return { t, type: "focus", of: e.target, hasFocus };
    case "focusout":
    case "blur":
      return { t, type: "blur", of: e.target, hasFocus };
    default:
      return null;
  }
}

const plain = (n: Node): string => n instanceof Text ? n.data : n.nodeName === "BR" ? "\n" : [...n.childNodes].map(plain).join("");

/** The offset in the editor's text, as `DomField` counts it, of DOM point (`node`, `offset`). */
export function textOffset(el: HTMLElement, node: Node, offset: number) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return plain(r.cloneContents()).replace(/​/g, "").length;
}

/** The DOM point of offset `at` in the editor's text. */
export function domPoint(el: HTMLElement, at: number): [Node, number] {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    last = n;
    for (let i = 0; i < n.length; i++) {
      if (n.data[i] === "​") continue;
      if (at-- === 0) return [n, i];
    }
  }
  return last ? [last, last.length] : [el, el.childNodes.length];
}

const editorEl = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.isContentEditable ? el : document.querySelector<HTMLElement>('[contenteditable="plaintext-only"]');
};

export function editorState(): EditorState {
  const el = editorEl();
  if (!el) return { text: "", at: 0, kind: null, editing: false };
  const kind = (["front", "notes", "title"] as const).find((k) => el.classList.contains(k)) ?? null;
  const sel = getSelection()!;
  const at = sel.rangeCount && el.contains(sel.focusNode) ? textOffset(el, sel.focusNode!, sel.focusOffset) : 0;
  // as DomField.text: an empty last line is drawn from a newline that is not part of the text
  const text = plain(el).replace(/​/g, "").replace(/\n$/, "");
  return { text, at, kind, editing: el.isContentEditable && document.activeElement === el };
}

const TYPES = ["keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "focusin", "focusout"];

export function install() {
  let trace: Trace | null = null, t0 = 0, pending: [number, number] | null = null;
  const push = (e: Event, target: "editor" | "window") => {
    if (!trace) return;
    const el = editorEl();
    if (e.type === "beforeinput" && el) {
      const r = (e as InputEvent).getTargetRanges()[0];
      pending = r ? [textOffset(el, r.startContainer, r.startOffset), textOffset(el, r.endContainer, r.endOffset)] : null;
    }
    const range = e.type === "beforeinput" || e.type === "input" ? pending : null;
    if (e.type === "input") pending = null;
    const k = e as KeyboardEvent & InputEvent & CompositionEvent;
    // an event's fields are getters on its prototype, which a spread would not copy
    const fields: EventFields = { type: e.type, target, key: k.key, code: k.code, keyCode: k.keyCode, isComposing: k.isComposing, metaKey: k.metaKey, ctrlKey: k.ctrlKey, altKey: k.altKey, shiftKey: k.shiftKey, data: k.data, inputType: k.inputType };
    const step = toStep(fields, performance.now() - t0, range, document.hasFocus());
    if (step) trace.steps.push(step);
  };
  for (const type of TYPES) addEventListener(type, (e) => push(e, "editor"), true);
  addEventListener("blur", (e) => e.target === window && push(e, "window"));
  addEventListener("focus", (e) => e.target === window && push(e, "window"));
  document.addEventListener("selectionchange", () => {
    const el = editorEl(), sel = getSelection()!;
    if (!trace || !el || !sel.rangeCount || !el.contains(sel.focusNode)) return;
    const range: [number, number] = [textOffset(el, sel.anchorNode!, sel.anchorOffset), textOffset(el, sel.focusNode!, sel.focusOffset)];
    trace.steps.push({ t: Math.round(performance.now() - t0), type: "selection", range });
  });
  (window as unknown as { breezyRecord: unknown }).breezyRecord = {
    start(meta: Omit<Trace, "ua" | "before" | "steps" | "after">) {
      t0 = performance.now();
      trace = { ...meta, ua: navigator.userAgent, before: editorState(), steps: [], after: editorState() };
    },
    stop(): Trace {
      const done = { ...trace!, after: editorState() };
      trace = null;
      return done;
    },
  };
}
