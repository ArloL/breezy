// Replays a trace's steps into the page's editor as the platform delivered them: each event dispatched as recorded,
// and each input's edit made to the DOM just before its input event, as the browser makes it. Runs in the page, which
// loaded web/record.ts with ?record.
import type { Step } from "../../web/record.ts";

type RecordModule = typeof import("../../web/record.ts");

/** Puts the caret at offset `at` of the editor's text. */
export async function setCaret(at: number) {
  const { domPoint }: RecordModule = await import("/record.js" as string);
  getSelection()!.collapse(...domPoint(document.activeElement as HTMLElement, at));
}

export async function replaySteps(steps: Step[]) {
  const { domPoint }: RecordModule = await import("/record.js" as string);
  const editor = () => document.querySelector<HTMLElement>('[contenteditable="plaintext-only"]') ?? document.activeElement as HTMLElement;
  const hasFocus = document.hasFocus.bind(document);
  let last = 0;
  for (const s of steps) {
    await new Promise((r) => setTimeout(r, Math.min(s.t - last, 50)));
    last = s.t;
    const el = editor();
    switch (s.type) {
      case "keydown":
      case "keyup": {
        const mods = s.mods.split("+");
        el.dispatchEvent(new KeyboardEvent(s.type, { key: s.key, code: s.code, isComposing: s.isComposing, keyCode: s.keyCode, metaKey: mods.includes("meta"), ctrlKey: mods.includes("ctrl"), altKey: mods.includes("alt"), shiftKey: mods.includes("shift"), bubbles: true, cancelable: true, composed: true }));
        break;
      }
      case "compositionstart":
      case "compositionupdate":
      case "compositionend":
        el.dispatchEvent(new CompositionEvent(s.type, { data: s.data, bubbles: true, cancelable: true }));
        break;
      case "beforeinput":
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: s.inputType, data: s.data, isComposing: s.isComposing, bubbles: true, cancelable: true }));
        break;
      case "input": {
        // the browser's own range where it gave one; Android gives none, and the text's change stands in, which can't
        // tell an insertion beside an equal character from one after it
        const edit = s.range ? [s.range[0], s.range[1], s.data ?? ""] as const : s.edit;
        if (edit && el.isContentEditable) {
          const r = document.createRange();
          r.setStart(...domPoint(el, edit[0]));
          r.setEnd(...domPoint(el, edit[1]));
          r.deleteContents();
          const t = document.createTextNode(edit[2]);
          if (edit[2]) r.insertNode(t);
          getSelection()!.collapse(...domPoint(el, edit[0] + edit[2].length));
        }
        el.dispatchEvent(new InputEvent("input", { inputType: s.inputType, data: s.data, isComposing: s.isComposing, bubbles: true }));
        break;
      }
      case "focus":
      case "blur":
        // as the platform reported whether the page had focus, which a headless page always has
        document.hasFocus = () => s.hasFocus;
        if (s.of === "window") window.dispatchEvent(new FocusEvent(s.type));
        else el.dispatchEvent(new FocusEvent(s.type));
        document.hasFocus = hasFocus;
        break;
      case "visibility":
        // as the platform reported it: a headless page is never hidden
        Object.defineProperty(document, "hidden", { value: s.hidden, configurable: true });
        Object.defineProperty(document, "visibilityState", { value: s.hidden ? "hidden" : "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        break;
      case "selection":
        if (el.isContentEditable) getSelection()!.setBaseAndExtent(...domPoint(el, s.range[0]), ...domPoint(el, s.range[1]));
        break;
    }
  }
}
