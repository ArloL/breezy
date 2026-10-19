/**
 * Whether an input method has key event `e`: while it composes, Esc cancels and Enter confirms its text, and neither is
 * the app's. Safari sends the Enter that confirms after compositionend, not composing but with keyCode 229.
 */
export function composingKey(e: { isComposing: boolean; keyCode: number }) {
  return e.isComposing || e.keyCode === 229;
}
