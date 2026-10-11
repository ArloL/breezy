let label: HTMLLabelElement | undefined;

/**
 * A light tap of the Taptic Engine, where iOS would give one. Safari 18 and later play it when a switch is toggled
 * through its label; it may only do so during a user gesture, and elsewhere this does nothing.
 */
export function haptic() {
  if (!label) {
    label = document.createElement("label");
    label.ariaHidden = "true";
    label.innerHTML = '<input type="checkbox" switch tabindex="-1">';
    label.style.cssText = "position: fixed; left: -100px; top: 0; opacity: 0; pointer-events: none;";
    document.body.append(label);
  }
  // the click focuses the switch, which would take the keyboard from the board: it goes back where it was
  const before = document.activeElement;
  label.click();
  const box = label.firstElementChild as HTMLElement;
  if (document.activeElement !== box) return;
  box.blur();
  if (before instanceof HTMLElement && before !== document.body) before.focus({ preventScroll: true });
}
