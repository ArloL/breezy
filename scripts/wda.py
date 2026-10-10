#!/usr/bin/env python3
"""Drives a real iPhone through WebDriverAgent, in points, for comparing Breezy with Apple's apps.

  scripts/wda.py launch BUNDLE_ID          start a session on an app, e.g. com.apple.freeform
  scripts/wda.py shot OUT.png              screenshot
  scripts/wda.py tap X Y
  scripts/wda.py touch STEP...             one finger: down X Y | move X Y MS | wait MS | up
  scripts/wda.py pinch CX CY R0 R1 MS HOLD two fingers R0 → R1 points from (CX, CY), horizontally, then held HOLD ms
  scripts/wda.py type TEXT                 types into the focused field; \n is Return
  scripts/wda.py source                    the accessibility tree, to find what to tap
  scripts/wda.py relaunch "Breezy Dev"     quits home-screen web apps and opens the icon with that label afresh

It reaches WebDriverAgent over USB, through iproxy 8100:8100 (brew install libimobiledevice), whatever network the phone
is on. WDA_URL overrides http://127.0.0.1:8100, e.g. with the address WebDriverAgent prints when it starts. Turning the
phone's Wi-Fi off still ends WebDriverAgent, as Xcode reaches it over the network, and Back Tap does nothing while a
session is open.
The session is remembered in /tmp/wda-session between calls.

Every touch first checks the app in front and refuses while a call is on screen, since it is a real phone.
WDA_EXPECT=BUNDLE_ID also refuses when another app is in front (a home-screen web app is com.apple.webapp).

The phone, an iPhone 13 mini at Display Zoom Larger Text, is 320 × 693 points, 3.375 px each.
Leave its Auto-Lock as it is; a test page keeps the screen on with navigator.wakeLock.request('screen')
on its first touch. In Freeform at this size, a text box (Add text box) is the drag subject: there is
no sticky-note button.
"""
import base64
import json
import os
import sys
import urllib.request

URL = os.environ.get("WDA_URL", "http://127.0.0.1:8100")
SESSION_FILE = "/tmp/wda-session"


def call(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["value"]


def session():
    with open(SESSION_FILE) as f:
        return f.read().strip()


CALLS = {"com.apple.InCallService", "com.apple.mobilephone", "com.apple.facetime", "com.apple.TelephonyUtilities"}


def guard():
    front = call("GET", "/wda/activeAppInfo")["bundleId"]
    if front in CALLS:
        sys.exit(f"refusing to touch: a call is on screen ({front})")
    expect = os.environ.get("WDA_EXPECT")
    if expect and front != expect:
        sys.exit(f"refusing to touch: {front} is in front, not {expect}")


def touch(steps):
    """W3C pointer actions: durations are milliseconds, coordinates points from the top left."""
    guard()
    actions = []
    x = y = 0.0
    down = False
    while steps:
        op = steps.pop(0)
        if op == "down":
            x, y = float(steps.pop(0)), float(steps.pop(0))
            actions += [{"type": "pointerMove", "duration": 0, "x": x, "y": y}, {"type": "pointerDown", "button": 0}]
            down = True
        elif op == "move":
            x, y, ms = float(steps.pop(0)), float(steps.pop(0)), int(steps.pop(0))
            actions.append({"type": "pointerMove", "duration": ms, "x": x, "y": y})
        elif op == "wait":
            ms = int(steps.pop(0))
            # WDA turns a pause before a move into part of that move, so a finger that should hold still drifts;
            # a move to where it already is keeps it there.
            actions.append({"type": "pointerMove", "duration": ms, "x": x, "y": y} if down else {"type": "pause", "duration": ms})
        elif op == "up":
            actions.append({"type": "pointerUp", "button": 0})
            down = False
        else:
            sys.exit(f"unknown step {op!r}")
    call("POST", f"/session/{session()}/actions",
         {"actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"}, "actions": actions}]})


def pinch(cx, cy, r0, r1, ms, hold):
    guard()
    def finger(name, sign):
        return {"type": "pointer", "id": name, "parameters": {"pointerType": "touch"}, "actions": [
            {"type": "pointerMove", "duration": 0, "x": cx + sign * r0, "y": cy},
            {"type": "pointerDown", "button": 0},
            {"type": "pause", "duration": 100},
            {"type": "pointerMove", "duration": ms, "x": cx + sign * r1, "y": cy},
            {"type": "pause", "duration": hold},
            {"type": "pointerUp", "button": 0},
        ]}
    call("POST", f"/session/{session()}/actions", {"actions": [finger("a", -1), finger("b", 1)]})


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
    elif cmd == "pinch":
        pinch(*map(float, args[:4]), int(args[4]), int(args[5]))
    elif cmd == "type":
        call("POST", f"/session/{session()}/wda/keys", {"value": list(args[0].replace("\\n", "\n"))})
    elif cmd == "relaunch":
        call("POST", f"/session/{session()}/wda/apps/terminate", {"bundleId": "com.apple.webapp"})
        call("POST", "/wda/homescreen")
        icon = call("POST", f"/session/{session()}/element", {"using": "accessibility id", "value": args[0]})
        call("POST", f"/session/{session()}/element/{icon['ELEMENT']}/click", {})
    elif cmd == "source":
        print(call("GET", f"/session/{session()}/source?format=description"))
    else:
        sys.exit(__doc__)


main()
