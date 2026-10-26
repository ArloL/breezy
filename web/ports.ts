import type { View } from "./view.ts";
import type { UI } from "./ui.ts";
import type { Presence } from "./presence.ts";
import type { Menus } from "./menu.ts";
import type { App } from "./app.ts";

/** What a field being edited tells the app. */
export interface FieldEvents {
  /** After every change to its text. */
  input(): void;
  /** When it loses the keyboard. */
  done(): void;
  /** On Return, for a field that Return ends. */
  enter?(): void;
}

/** A card side's text or a lane's title being edited: a contentEditable element in a browser, a string in tests. */
export interface Field {
  /** Shows `text` to edit, with the keyboard and the caret at its end. */
  open(text: string, on: FieldEvents): void;
  /** The text as edited so far. */
  text(): string;
  /** Where the caret is in `text()`, or null when it is not in the field. */
  caret(): number | null;
  /** No more events, though it stays as it is. */
  detach(): void;
  /** No more events, no keyboard, no editing. */
  close(): void;
}

/** What the app uses of what draws the board: the DOM in a browser, a fake in tests. */
export type ViewPort = Pick<View,
  | "cam" | "camera" | "heightOf" | "frontHeight" | "ready" | "area" | "onCamera" | "onRender" | "shown" | "els"
  | "invalidate" | "render" | "setCamera" | "toWorld" | "toScreen" | "rectOf" | "centre" | "zoomAround" | "centreOn"
  | "reveal" | "caretRect" | "topOf" | "editorOf" | "titleOf" | "animateTurn">;

/** What the app uses of the bars, menus and find around the board. */
export type UIPort = Pick<UI, "haptic" | "update" | "updateSync" | "updateZoom" | "area" | "closeMenu" | "openFind" | "findStep" | "closeFind" | "find" | "act">
  & { menus: Pick<Menus, "attach"> };

/** What the app uses of others' cursors and carets. */
export type PresencePort = Pick<Presence, "place" | "show">;

/** The open board's space: holds what a gesture takes, and hears when what it holds floats off the grid. */
export interface SpacePort {
  hold(ids: Iterable<string>): void;
  edited(): void;
}

/** Makes the app's ports, in this order: the view first, as the others draw on it. */
export interface Ports {
  view(app: App): ViewPort;
  presence(view: ViewPort): PresencePort;
  ui(app: App): UIPort;
}
