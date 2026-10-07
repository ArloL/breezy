#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.11.*"
# dependencies = ["fb-idb"]
# ///
"""Touches the booted simulator's screen, in points, as one idb event stream so the delays hold.

  scripts/sim-touch.py STEP...    down X Y | move X Y SECONDS | up | wait SECONDS

Tap, then hold and drag (the web prototype's one-finger zoom):

  scripts/sim-touch.py down 120 352 wait .05 up wait .1 down 120 352 wait .5 move 120 432 .6 wait 1 up

Needs `brew install facebook/fb/idb-companion`.
"""
import asyncio
import json
import logging
import shutil
import subprocess
import sys

from idb.common.types import HIDDelay, HIDDirection, HIDPress, HIDTouch, Point
from idb.grpc.management import ClientManager

STEP_S = 0.02


def touch(x, y, direction):
    return HIDPress(action=HIDTouch(point=Point(x=x, y=y)), direction=direction)


def events(args):
    x = y = 0.0
    while args:
        op = args.pop(0)
        if op == "down":
            x, y = float(args.pop(0)), float(args.pop(0))
            yield touch(x, y, HIDDirection.DOWN)
        elif op == "move":
            tx, ty, s = float(args.pop(0)), float(args.pop(0)), float(args.pop(0))
            n = max(1, round(s / STEP_S))
            for i in range(1, n + 1):
                # Another down while the finger is down moves it.
                yield touch(x + (tx - x) * i / n, y + (ty - y) * i / n, HIDDirection.DOWN)
                yield HIDDelay(duration=STEP_S)
            x, y = tx, ty
        elif op == "up":
            yield touch(x, y, HIDDirection.UP)
        elif op == "wait":
            yield HIDDelay(duration=float(args.pop(0)))
        else:
            sys.exit(f"unknown step {op!r}")


def booted_udid():
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "booted", "--json"]))["devices"]
    udids = [d["udid"] for ds in devices.values() for d in ds]
    if len(udids) != 1:
        sys.exit(f"expected one booted simulator, found {len(udids)}")
    return udids[0]


async def main():
    stream = list(events(sys.argv[1:]))
    manager = ClientManager(companion_path=shutil.which("idb_companion"), logger=logging.getLogger("sim-touch"))
    async with manager.from_udid(udid=booted_udid()) as client:
        await client.send_events(stream)


asyncio.run(main())
