import type { View } from "./view.ts";
import type { UI } from "./ui.ts";
import type { Presence } from "./presence.ts";
import type { Menus } from "./menu.ts";
import type { App } from "./app.ts";

/** What the app uses of what draws the board: the DOM in a browser, a fake in tests. */
export type ViewPort = Pick<View,
  | "cam" | "camera" | "heightOf" | "frontHeight" | "ready" | "area" | "onCamera" | "onRender" | "shown" | "els"
  | "invalidate" | "render" | "setCamera" | "toWorld" | "toScreen" | "rectOf" | "centre" | "zoomAround" | "centreOn"
  | "reveal" | "caretRect" | "editorOf" | "titleOf" | "animateTurn">;

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
