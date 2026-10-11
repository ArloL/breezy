let label;

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
  label.click();
}
