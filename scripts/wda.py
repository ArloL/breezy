#!/usr/bin/env python3
"""Drives a real iPhone through WebDriverAgent, in points, for comparing Breezy with Apple's apps.

  scripts/wda.py launch BUNDLE_ID          start a session on an app, e.g. com.apple.freeform
  scripts/wda.py shot OUT.png              screenshot
  scripts/wda.py tap X Y
  scripts/wda.py touch STEP...             one finger: down X Y | move X Y MS | wait MS | up
  scripts/wda.py source                    the accessibility tree, to find what to tap

WDA_URL overrides http://192.168.178.46:8100, the address WebDriverAgent prints when it starts.
The session is remembered in /tmp/wda-session between calls.
"""
import base64
import json
import os
import sys
import urllib.request

URL = os.environ.get("WDA_URL", "http://192.168.178.46:8100")
SESSION_FILE = "/tmp/wda-session"


def call(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["value"]


def session():
    with open(SESSION_FILE) as f:
        return f.read().strip()


def touch(steps):
    """W3C pointer actions: durations are milliseconds, coordinates points from the top left."""
    actions = []
    while steps:
        op = steps.pop(0)
        if op == "down":
            x, y = float(steps.pop(0)), float(steps.pop(0))
            actions += [{"type": "pointerMove", "duration": 0, "x": x, "y": y}, {"type": "pointerDown", "button": 0}]
        elif op == "move":
            x, y, ms = float(steps.pop(0)), float(steps.pop(0)), int(steps.pop(0))
            actions.append({"type": "pointerMove", "duration": ms, "x": x, "y": y})
        elif op == "wait":
            actions.append({"type": "pause", "duration": int(steps.pop(0))})
        elif op == "up":
            actions.append({"type": "pointerUp", "button": 0})
        else:
            sys.exit(f"unknown step {op!r}")
    call("POST", f"/session/{session()}/actions",
         {"actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"}, "actions": actions}]})


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "launch":
        v = call("POST", "/session", {"capabilities": {"alwaysMatch": {"bundleId": args[0], "shouldWaitForQuiescence": False}}})
        with open(SESSION_FILE, "w") as f:
            f.write(v["sessionId"])
    elif cmd == "shot":
        with open(args[0], "wb") as f:
            f.write(base64.b64decode(call("GET", "/screenshot")))
    elif cmd == "tap":
        touch(["down", args[0], args[1], "wait", "50", "up"])
    elif cmd == "touch":
        touch(args)
    elif cmd == "source":
        print(call("GET", f"/session/{session()}/source?format=description"))
    else:
        sys.exit(__doc__)


main()
