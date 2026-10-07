import { App } from "./app.js";
import { Gestures, HOLD_MS } from "./gestures.js";
import { sampleBoard, stressBoard } from "./sample.js";

const params = new URLSearchParams(location.search);
const app = new App(params.has("stress") ? stressBoard() : sampleBoard());
app.view.setCamera({ x: 16, y: app.ui.area().top + 16, zoom: 0.75 });
app.view.render();

const gestures = new Gestures(app.input);
document.getElementById("board").addEventListener("pointerdown", (e) => {
  if (e.target.closest('[contenteditable="plaintext-only"]')) return;
  app.input.touchStart();
  gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  setTimeout(() => gestures.tick(performance.now()), HOLD_MS + 10);
});
// A touch's compatibility mousedown comes after pointerup and would take focus from an editor that tap just opened.
document.getElementById("board").addEventListener("mousedown", (e) => {
  if (!e.target.closest('[contenteditable="plaintext-only"]')) e.preventDefault();
});
// Tap, then hold and drag, is iOS's text gesture too: it shows the magnifier over card text even where text cannot be selected.
document.getElementById("board").addEventListener("touchstart", (e) => {
  if (!e.target.closest('[contenteditable="plaintext-only"]')) e.preventDefault();
}, { passive: false });
addEventListener("pointermove", (e) => gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp));
addEventListener("pointerup", (e) => gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp));
addEventListener("pointercancel", (e) => gestures.cancel(e.pointerId));
// iOS can hide the page mid-gesture, as when swiping home, without a pointercancel.
document.addEventListener("visibilitychange", () => document.hidden && gestures.cancelAll());
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault());

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
