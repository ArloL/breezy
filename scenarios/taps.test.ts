// The iPhone's driver calls a double tap's taps apart just when the board does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gestures, type GestureHandler } from "../web/gestures.ts";
import { apart } from "./ios.ts";

for (const gap of [0, 250, 300, 301, 450]) {
  test(`taps ${gap} ms apart`, () => {
    let doubled = false;
    const g = new Gestures(new Proxy({} as GestureHandler, { get: (_, k) => () => void (doubled ||= k === "doubleTap") }));
    const times: [string, number][] = [["pointerdown", 1000], ["pointerup", 1050], ["pointerdown", 1050 + gap], ["pointerup", 1100 + gap]];
    for (const [type, t] of times) g[type === "pointerdown" ? "down" : "up"](1, 100, 100, t);
    assert.equal(apart(times) === null, doubled);
  });
}
