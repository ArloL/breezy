import { composingKey } from "./ime.ts";

export interface Answer {
  value?: string;
  danger?: boolean;
  choice?: number;
}

/**
 * A small sheet over everything, as an iOS alert: a title, maybe a line of text and a field, and buttons. Resolves to
 * { value } for OK, { danger: true } for the red button, { choice: i } for the i-th of `choices`, or null for Cancel.
 * Passing `value` shows the field. Esc or a click beside the sheet is Cancel, when it has one.
 */
export function ask({ title, message = "", value, placeholder = "", ok = "OK", danger = null, cancel = "Cancel", choices = [] }: {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  ok?: string | null;
  danger?: string | null;
  cancel?: string | null;
  choices?: string[];
}): Promise<Answer | null> {
  const sheet = document.getElementById("sheet")!;
  const form = sheet.querySelector("form")!;
  const field = sheet.querySelector("input")!;
  const [cancelButton, dangerButton, okButton] = ["cancel", "danger", "ok"].map((k) => sheet.querySelector<HTMLButtonElement>(`[data-sheet="${k}"]`)!);
  sheet.querySelector(".sheet-title")!.textContent = title;
  const text = sheet.querySelector<HTMLElement>(".sheet-message")!;
  text.textContent = message;
  text.hidden = !message;
  field.hidden = value === undefined;
  field.value = value ?? "";
  field.placeholder = placeholder;
  for (const [b, label] of [[okButton, ok], [dangerButton, danger], [cancelButton, cancel]] as const) {
    b.textContent = label ?? "";
    b.hidden = !label;
  }
  sheet.hidden = false;
  if (!field.hidden) field.focus();
  return new Promise((resolve) => {
    const done = (result: Answer | null) => {
      sheet.hidden = true;
      field.blur();
      form.onsubmit = dangerButton.onclick = cancelButton.onclick = sheet.onpointerdown = sheet.onclick = null;
      removeEventListener("keydown", key, true);
      resolve(result);
    };
    // before the board's keys, which would take Esc for themselves
    const key = (e: KeyboardEvent) => {
      if (!cancels(e, cancel !== null)) return;
      e.preventDefault();
      e.stopPropagation();
      done(null);
    };
    if (cancel !== null) addEventListener("keydown", key, true);
    // pressed and let go beside the card: a drag that began in the field and ends outside is not a cancel
    let downBeside = false;
    // in blocks, as an on- handler that returns false cancels its event: here the click Enter sends to the submit button
    sheet.onpointerdown = (e) => {
      downBeside = e.target === sheet;
    };
    sheet.onclick = (e) => {
      if (downBeside && e.target === sheet && cancel !== null) done(null);
    };
    const list = sheet.querySelector<HTMLElement>(".sheet-choices")!;
    list.replaceChildren(...choices.map((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = () => done({ choice: i });
      return b;
    }));
    list.hidden = !choices.length;
    form.onsubmit = (e) => {
      e.preventDefault();
      done({ value: field.value });
    };
    dangerButton.onclick = () => done({ danger: true });
    cancelButton.onclick = () => done(null);
  });
}

/** Whether key event `e` cancels a sheet that `canCancel`: Esc, unless an input method composing takes it. */
export function cancels(e: { key: string; isComposing: boolean; keyCode: number }, canCancel: boolean) {
  return canCancel && e.key === "Escape" && !composingKey(e);
}
