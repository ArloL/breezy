export type PanMode = "camera" | "native";

export const PAN_KEY = "breezy.pan";

const isMode = (v: string | null): v is PanMode => v === "camera" || v === "native";

/** `?pan=native|camera` wins, then the stored choice, else the camera. */
export function panMode(search: string, stored: string | null): PanMode {
  const asked = new URLSearchParams(search).get("pan");
  return isMode(asked) ? asked : isMode(stored) ? stored : "camera";
}

export function storedPan(): string | null {
  try {
    return localStorage.getItem(PAN_KEY);
  } catch {
    return null;
  }
}

export function storePan(mode: PanMode) {
  try {
    localStorage.setItem(PAN_KEY, mode);
  } catch {}
}
