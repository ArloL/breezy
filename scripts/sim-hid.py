#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.11.*"
# dependencies = ["fb-idb"]
# ///
"""Touches and types into a booted simulator for the scenarios, over one idb connection kept open:

  scripts/sim-hid.py UDID

Reads a JSON line per command on stdin and answers each with a JSON line:

  {"touches": [[ms, "down" | "move" | "up", x, y], ...]}   one finger, each event after its wait, in screen points,
                                                            sent as one HID stream so the waits hold
  {"text": "..."}                                          typed through the simulator's keyboard
  {"key": 40}                                              one key by its HID usage: 40 Return, 42 Delete, 41 Escape

  -> {"ok": true, "ms": how long it took} or {"error": "..."}

Needs `brew install facebook/fb/idb-companion`.
"""
import asyncio
import json
import logging
import shutil
import sys
import time

from idb.common.types import HIDDelay, HIDDirection, HIDPress, HIDTouch, Point
from idb.grpc.management import ClientManager


def stream(touches):
    for ms, phase, x, y in touches:
        if ms:
            yield HIDDelay(duration=ms / 1000)
        # another down while the finger is down moves it
        direction = HIDDirection.UP if phase == "up" else HIDDirection.DOWN
        yield HIDPress(action=HIDTouch(point=Point(x=x, y=y)), direction=direction)


async def main():
    manager = ClientManager(companion_path=shutil.which("idb_companion"), logger=logging.getLogger("sim-hid"))
    async with manager.from_udid(udid=sys.argv[1]) as client:
        print(json.dumps({"ok": True, "ms": 0}), flush=True)
        loop = asyncio.get_running_loop()
        while line := await loop.run_in_executor(None, sys.stdin.readline):
            t0 = time.monotonic()
            try:
                c = json.loads(line)
                if "touches" in c:
                    await client.send_events(list(stream(c["touches"])))
                elif "text" in c:
                    await client.text(c["text"])
                elif "key" in c:
                    await client.key(c["key"])
                else:
                    raise ValueError(f"unknown command {line.strip()}")
                print(json.dumps({"ok": True, "ms": round((time.monotonic() - t0) * 1000)}), flush=True)
            except Exception as e:
                print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


asyncio.run(main())
