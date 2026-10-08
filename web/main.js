import { App } from "./app.js";
import { Gestures, HOLD_MS } from "./gestures.js";
import { sampleBoard, stressBoard } from "./sample.js";
import { startUpdates } from "./update.js";
import { Mouse } from "./mouse.js";
import { wheelAction } from "./wheel.js";
import { command, perform } from "./keys.js";
import { Library } from "./library.js";

const params = new URLSearchParams(location.search);
// ?stress and ?demo show boards that are not kept, as before
const scratch = params.has("stress") ? stressBoard() : params.has("demo") ? sampleBoard() : null;
const app = new App(scratch ?? { cards: [], lanes: [] });
app.view.setCamera({ x: 16, y: app.ui.area().top + 16, zoom: 0.75 });
app.view.render();
startUpdates(app);

const board = document.getElementById("board");
const gestures = new Gestures(app.input);
const mouse = new Mouse(app);
const editor = (e) => e.target.closest?.('[contenteditable="plaintext-only"]');
board.addEventListener("pointerdown", (e) => {
  if (editor(e)) return;
  app.touching = e.pointerType !== "mouse";
  if (e.pointerType === "mouse") {
    if (e.button !== 0) return;
    // a click on the board takes the keyboard from the find field, as clicking the canvas does on the Mac
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    board.setPointerCapture(e.pointerId);
    return mouse.down({ x: e.clientX, y: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey }, e.timeStamp);
  }
  app.input.touchStart();
  gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  setTimeout(() => gestures.tick(performance.now()), HOLD_MS + 10);
});
// A touch's compatibility mousedown comes after pointerup and would take focus from an editor that tap just opened.
board.addEventListener("mousedown", (e) => editor(e) || e.preventDefault());
// Tap, then hold and drag, is iOS's text gesture too: it shows the magnifier over card text even where text cannot be selected.
board.addEventListener("touchstart", (e) => editor(e) || e.preventDefault(), { passive: false });
addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") return mouse.move({ x: e.clientX, y: e.clientY, buttons: e.buttons });
  gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse") return e.button === 0 && mouse.up({ x: e.clientX, y: e.clientY });
  gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointercancel", (e) => (e.pointerType === "mouse" ? mouse.cancel() : gestures.cancel(e.pointerId)));
addEventListener("pointerout", (e) => e.pointerType === "mouse" && !e.relatedTarget && mouse.leave());
board.addEventListener("contextmenu", (e) => editor(e) || e.preventDefault());

addEventListener("wheel", (e) => {
  if (document.body.dataset.screen === "boards") return;
  e.preventDefault();
  // should Safari also send the pinch as ⌃-wheel, it would zoom twice
  if (pinch !== null && e.ctrlKey) return;
  const a = wheelAction(e);
  const view = app.view;
  if (a.zoom) view.zoomAround({ x: e.clientX, y: e.clientY }, view.cam.zoom * a.zoom);
  else view.setCamera({ ...view.cam, x: view.cam.x + a.pan.x, y: view.cam.y + a.pan.y });
  // what a held drag is over has moved
  if (app.input.drag) app.input.dragMove(app.input.drag.last);
}, { passive: false });

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
addEventListener("keydown", (e) => {
  if (document.body.dataset.screen === "boards") return;
  const s = app.state;
  const typing = s.editing ? "card" : s.renaming ? "lane" : e.target.closest?.("input, textarea") ? "field" : null;
  const cmd = command(e, { mac, typing });
  if (!cmd) return;
  e.preventDefault();
  perform(app, cmd, mouse);
});
// iOS can hide the page mid-gesture, as when swiping home, without a pointercancel.
document.addEventListener("visibilitychange", () => document.hidden && gestures.cancelAll());
// Safari reports a trackpad pinch as gesture events, their scale counting from the pinch's start; a touch pinch comes as pointers.
let pinch = null;
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
  document.querySelector("#find input").value = "plan";
  app.ui.find("plan");
}
if (demo === "add") app.ui.act("add");

if (!scratch) {
  document.body.dataset.screen = "boards";
  await Library.open(app);
}
