#!/usr/bin/env python3
"""Writes the web prototype's launch images and prints the <link> tags for them.

  scripts/make-web-launch.py web

iOS shows an apple-touch-startup-image while a home-screen web app starts, and white without one. These are the
board's paper colour, light and dark, with nothing on them, as Apple asks of a launch screen. Sizes are portrait
CSS points and pixel ratios; 320×693 is an iPhone mini at Display Zoom.
"""
import os
import struct
import sys
import zlib

SIZES = [(375, 667, 2), (320, 693, 3), (375, 812, 3), (390, 844, 3), (393, 852, 3), (402, 874, 3), (414, 896, 2),
         (414, 896, 3), (420, 912, 3), (428, 926, 3), (430, 932, 3), (440, 956, 3)]
SCHEMES = {"light": (0xF1, 0xEF, 0xEA), "dark": (0x1F, 0x1E, 0x1C)}  # --paper in style.css
# Display Zoom draws 320×693 points on the iPhone mini's 1080×2340 pixels.
PIXELS = {(320, 693, 3): (1080, 2340)}


def png(w, h, rgb):
    row = b"\x00" + bytes(rgb) * w
    data = zlib.compress(row * h, 9)
    chunk = lambda kind, body: struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", data) + chunk(b"IEND", b"")


out = sys.argv[1]
os.makedirs(os.path.join(out, "launch"), exist_ok=True)
for (w, h, r) in SIZES:
    pw, ph = PIXELS.get((w, h, r), (w * r, h * r))
    for scheme, rgb in SCHEMES.items():
        name = f"launch/{scheme}-{pw}x{ph}.png"
        with open(os.path.join(out, name), "wb") as f:
            f.write(png(pw, ph, rgb))
        print(f'<link rel="apple-touch-startup-image" href="{name}" media="(device-width: {w}px) and (device-height: {h}px) '
              f'and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait) and (prefers-color-scheme: {scheme})">')
