// Level 2's replay: a stroke as a browser handed it to the page, one capture row's input at a time, through the web core
// on a fake clock, as the page takes a wheel in camera mode (web/main.ts, wheelOnCamera), and the frames that kept.
import { BoardCamera } from "../../board-camera.ts";
import { Flight } from "../../flight.ts";
import { FrameRecorder, WheelFrames } from "../../frames.ts";
import { wheelOnCamera, ZOOM_PER_PT } from "../../wheel.ts";
import type { FrameTrack } from "../../flight.ts";

/** How long after a capture's last input the replay runs on: a stroke's rest and its spring. */
const AFTER = 1500;

/** Replays `capture`'s input at its rows' times, 120 frames a second, on the empty reference board where its first
 * row's camera was, and gives the frames the recorder kept. A row's wheel deltas are one wheel event, AppKit's way
 * round as the frames hold them; its magnification one ⌃-wheel step of as much; its place the pointer's. */
export function replayCapture(capture: FrameTrack, { stage }: { stage?: { w: number; h: number } } = {}): FrameTrack {
  const col = (k: string) => capture.fields.indexOf(k), v = (r: (number | null)[], k: string) => (col(k) >= 0 ? r[col(k)] ?? 0 : 0);
  const first = capture.rows[0]!, z0 = v(first, "zoom") || 1;
  const size = stage ?? { w: v(first, "viewW") || 1495, h: v(first, "viewH") || 932 };
  let now = 0, id = 0, frames: ((t: number) => void)[] = [];
  const timers: { at: number; f: () => void; id: number }[] = [];
  const clock = {
    now: () => now,
    raf: (f: (t: number) => void) => (frames.push(f), ++id),
    caf: () => {},
    setTimer: (f: () => void, ms: number) => (timers.push({ at: now + ms, f, id: ++id }), id),
    clearTimer: (i: unknown) => { const k = timers.findIndex((t) => t.id === i); if (k >= 0) timers.splice(k, 1); },
  };
  const core = new BoardCamera({
    board: () => ({ cards: [], lanes: [] }), rectOf: () => ({ x: 0, y: 0, w: 0, h: 0 }),
    stage: () => ({ left: 0, top: 0, right: size.w, bottom: size.h }), apply: () => recorder.wake(), rested: () => {}, clock,
  });
  const flight = new Flight({ now: () => now });
  const recorder = new FrameRecorder(flight, {
    cam: () => core.cam, stage: () => size, board: () => core.board(), coverTop: () => false, gridShort: () => 0,
  }, { raf: clock.raf, caf: clock.caf, hidden: () => false });
  const wheels = new WheelFrames(recorder, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  core.setCamera({ x: -v(first, "camX") * z0, y: -v(first, "camY") * z0, zoom: z0 });
  recorder.wake();

  const t0 = first[0] ?? 0;
  const inputs = capture.rows.filter((r) => v(r, "wheelDX") || v(r, "wheelDY") || v(r, "magnify")).map((r) => ({ at: (r[0] ?? 0) - t0, r }));
  const end = (inputs.at(-1)?.at ?? 0) + AFTER;
  for (let k = 0; now <= end; ) {
    for (; k < inputs.length && inputs[k]!.at <= now; k++) {
      const r = inputs[k]!.r, m = v(r, "magnify"), at = { clientX: v(r, "px"), clientY: v(r, "py") };
      // a frame's magnification is its steps' (zoom − 1) summed: past −1 no step gives it, and the camera would go NaN
      if (1 + m <= 0) throw new Error(`magnification ${m} at ${inputs[k]!.at} ms: no one ⌃-wheel step zooms by that`);
      // a magnification of m is the ⌃-wheel step wheelAction zooms by 1 + m
      const e = m
        ? { deltaX: 0, deltaY: -Math.log(1 + m) / ZOOM_PER_PT, deltaMode: 0, ctrlKey: true, metaKey: false, ...at }
        : { deltaX: -v(r, "wheelDX"), deltaY: -v(r, "wheelDY"), deltaMode: 0, ctrlKey: false, metaKey: false, ...at };
      wheels.take(e);
      wheelOnCamera(core, e);
    }
    now += 8;
    for (const t of timers.filter((t) => t.at <= now)) (timers.splice(timers.indexOf(t), 1), t.f());
    const due = frames;
    frames = [];
    for (const f of due) f(now);
  }
  return flight.recording().frames ?? { fields: [...Flight.frameFields], rows: [] };
}
