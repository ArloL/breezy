/**
 * A small sheet over everything, as an iOS alert: a title, maybe a line of text and a field, and buttons. Resolves to
 * { value } for OK, { danger: true } for the red button, or null for Cancel. Passing `value` shows the field.
 */
export function ask({ title, message = "", value, placeholder = "", ok = "OK", danger = null, cancel = "Cancel" }) {
  const sheet = document.getElementById("sheet");
  const form = sheet.querySelector("form");
  const field = sheet.querySelector("input");
  const [cancelButton, dangerButton, okButton] = ["cancel", "danger", "ok"].map((k) => sheet.querySelector(`[data-sheet="${k}"]`));
  sheet.querySelector(".sheet-title").textContent = title;
  const text = sheet.querySelector(".sheet-message");
  text.textContent = message;
  text.hidden = !message;
  field.hidden = value === undefined;
  field.value = value ?? "";
  field.placeholder = placeholder;
  for (const [b, label] of [[okButton, ok], [dangerButton, danger], [cancelButton, cancel]]) {
    b.textContent = label ?? "";
    b.hidden = !label;
  }
  sheet.hidden = false;
  if (!field.hidden) field.focus();
  return new Promise((resolve) => {
    const done = (result) => {
      sheet.hidden = true;
      field.blur();
      form.onsubmit = dangerButton.onclick = cancelButton.onclick = null;
      resolve(result);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      done({ value: field.value });
    };
    dangerButton.onclick = () => done({ danger: true });
    cancelButton.onclick = () => done(null);
  });
}
