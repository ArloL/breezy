import { App } from "./app.ts";
import { thrown } from "./flight.ts";
import { Gestures, HOLD_MS, holdCheck } from "./gestures.ts";
import { sampleBoard, stressBoard } from "./sample.ts";
import { startUpdates } from "./update.ts";
import { Mouse } from "./mouse.ts";
import { wheelAction } from "./wheel.ts";
import { command, onMac, perform } from "./keys.ts";
import { Library } from "./library.ts";
import { ownBoards } from "./owner.ts";
import { ask } from "./sheet.ts";
import { View } from "./view.ts";
import { UI } from "./ui.ts";
import { Presence } from "./presence.ts";

/** Safari's trackpad pinch. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

declare global {
  interface DocumentEventMap {
    gesturestart: GestureEvent;
    gesturechange: GestureEvent;
    gestureend: GestureEvent;
  }
}

/** Notes in the app's recorder what only the page knows: which device and build, its lifecycle, what of the screen it
 * shows, a frame at a time, and its errors; and lets a scenario or an upload read the recorder. */
function record(app: App) {
  const f = app.flight;
  (globalThis as { breezyFlight?: typeof f }).breezyFlight = f;
  const version = document.querySelector<HTMLElement>('[data-act="version"]')?.dataset.version ?? null;
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  const about = { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio, standalone, version };
  f.context(about);
  f.note("context", "page", about);
  document.addEventListener("visibilitychange", () => f.note("life", document.hidden ? "hidden" : "visible"));
  addEventListener("pagehide", () => f.note("life", "pagehide"));
  addEventListener("pageshow", (e) => f.note("life", "pageshow", { persisted: e.persisted }));
  let due = false;
  const viewport = () => {
    if (due) return;
    due = true;
    requestAnimationFrame(() => {
      due = false;
      const v = visualViewport;
      f.note("geometry", "viewport", { inner: [innerWidth, innerHeight], visual: v ? [Math.round(v.offsetTop), Math.round(v.height), Math.round(v.width)] : null, ...app.geometry() });
    });
  };
  addEventListener("resize", viewport);
  visualViewport?.addEventListener("resize", viewport);
  visualViewport?.addEventListener("scroll", viewport);
  addEventListener("error", (e) => f.note("error", "uncaught", thrown(e.error ?? e.message)));
  addEventListener("unhandledrejection", (e) => f.note("error", "rejected", thrown(e.reason)));
}

const params = new URLSearchParams(location.search);
if (params.has("record")) void import("./record.ts").then((m) => m.install());
// ?stress and ?demo show boards that are not kept, as before
const scratch = params.has("stress") ? stressBoard() : params.has("demo") ? sampleBoard() : null;
const app = new App(scratch ?? { cards: [], lanes: [] }, {
  view: (app) => new View(document.getElementById("board")!, app.model, app.state),
  presence: (view) => new Presence(view),
  ui: (app) => new UI(app),
});
app.view.setCamera({ x: 16, y: app.ui.area().top + 16, zoom: 0.75 });
app.view.render();
startUpdates(app);
record(app);

const board = document.getElementById("board")!;
const gestures = new Gestures(app.input);
const mouse = new Mouse(app);
const editor = (e: Event) => (e.target as Element).closest?.('[contenteditable="plaintext-only"]');
/** A mouse press that began on the board, not in an editor, though its double-click may have opened one under it. */
let boardClick = false;
board.addEventListener("pointerdown", (e) => {
  boardClick = e.pointerType === "mouse" && !editor(e);
  if (editor(e)) return;
  app.touching = e.pointerType !== "mouse";
  app.library?.pointerAt({ x: e.clientX, y: e.clientY });
  if (e.pointerType === "mouse") {
    if (e.button !== 0) return;
    // a click on the board takes the keyboard from the find field, as clicking the canvas does on the Mac
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    board.setPointerCapture(e.pointerId);
    return mouse.down({ x: e.clientX, y: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey }, e.timeStamp);
  }
  app.input.touchStart({ x: e.clientX, y: e.clientY });
  gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  holdCheck(performance.now() + HOLD_MS + 10, (t) => gestures.tick(t));
});
// A touch's compatibility mousedown comes after pointerup and would take focus from an editor that tap just opened. The
// mousedown of a double-click that opened an editor would select the word under the pointer, which typing replaces.
board.addEventListener("mousedown", (e) => (editor(e) && !boardClick) || e.preventDefault());
// Tap, then hold and drag, is iOS's text gesture too: it shows the magnifier over card text even where text cannot be selected.
board.addEventListener("touchstart", (e) => editor(e) || e.preventDefault(), { passive: false });
addEventListener("pointermove", (e) => {
  app.library?.pointerAt({ x: e.clientX, y: e.clientY });
  if (e.pointerType === "mouse") return mouse.move({ x: e.clientX, y: e.clientY, buttons: e.buttons });
  gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse") app.library?.touchEnded();
  if (e.pointerType === "mouse") return e.button === 0 && mouse.up({ x: e.clientX, y: e.clientY });
  gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointercancel", (e) => (e.pointerType === "mouse" ? mouse.cancel() : gestures.cancel(e.pointerId)));
addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse" || e.relatedTarget) return;
  mouse.leave();
  app.library?.pointerAt(null);
});
board.addEventListener("contextmenu", (e) => editor(e) || e.preventDefault());
// a tap between the keyboard bar's buttons would take focus from the editor, which ends the edit
document.getElementById("keys")!.addEventListener("mousedown", (e) => e.preventDefault());

addEventListener("wheel", (e) => {
  if (document.body.dataset.screen === "boards") return;
  e.preventDefault();
  // should Safari also send the pinch as ⌃-wheel, it would zoom twice
  if (pinch !== null && e.ctrlKey) return;
  const a = wheelAction(e);
  const view = app.view;
  if (a.zoom) view.zoomAround({ x: e.clientX, y: e.clientY }, view.cam.zoom * a.zoom);
  else view.setCamera({ ...view.cam, x: view.cam.x + a.pan!.x, y: view.cam.y + a.pan!.y });
  // what a held drag is over has moved
  if (app.input.drag) app.input.dragMove(app.input.drag.last);
}, { passive: false });

const mac = onMac(navigator.userAgent);
addEventListener("keydown", (e) => {
  if (document.body.dataset.screen === "boards") return;
  const s = app.state;
  const typing = s.editing ? "card" : s.renaming ? "lane" : (e.target as Element).closest?.("input, textarea") ? "field" : null;
  const cmd = command(e, { mac, typing });
  if (!cmd) return;
  e.preventDefault();
  perform(app, cmd, mouse);
});
// iOS can hide the page mid-gesture, as when swiping home, without a pointercancel.
document.addEventListener("visibilitychange", () => document.hidden && gestures.cancelAll());
// Safari reports a trackpad pinch as gesture events, their scale counting from the pinch's start; a touch pinch comes as pointers.
let pinch: number | null = null;
document.addEventListener("gesturestart", (e) => {
  e.preventDefault();
  if (!gestures.points.size) pinch = app.view.cam.zoom;
});
document.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  if (pinch !== null) app.view.zoomAround({ x: e.clientX, y: e.clientY }, pinch * e.scale);
});
document.addEventListener("gestureend", (e) => {
  e.preventDefault();
  pinch = null;
});

// States for screenshots.
const demo = params.get("demo");
const id = "c-offsite";
if (demo === "select") app.select([id]);
if (demo === "turn") {
  app.select([id]);
  app.turn(id);
}
if (demo === "edit") app.beginEdit(id);
if (demo === "lift") {
  app.state.lifted = new Set([id]);
  app.select([id]);
}
if (demo === "find") {
  app.ui.openFind();
  document.querySelector<HTMLInputElement>("#find input")!.value = "plan";
  app.ui.find("plan");
}
if (demo === "add") app.ui.act("add");

if (!scratch) {
  document.body.dataset.screen = "boards";
  let waited = false, opened: Promise<Library>;
  await ownBoards({
    locks: globalThis.BroadcastChannel && navigator.locks,
    channel: globalThis.BroadcastChannel && new BroadcastChannel("breezy-boards"),
    waiting: async (useHere) => {
      waited = true;
      // shown again until the boards come, as the other tab may not answer
      for (;;) {
        await ask({ title: "Breezy is open in another tab", ok: "Use Here", cancel: null });
        useHere();
      }
    },
    handOver: () => opened.then((library) => library.handOver()),
    handedOver: () => location.reload(),
  });
  if (waited) document.getElementById("sheet")!.hidden = true;
  opened = Library.open(app);
  await opened;
}
