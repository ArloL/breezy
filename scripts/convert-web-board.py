"""Converts a web-version board.html to a .breezy file: python3 scripts/convert-web-board.py IN.html OUT.breezy"""
import json
import re
import sys

html = open(sys.argv[1], encoding="utf-8").read()
data = json.loads(re.search(r'<script type="application/json" id="board-data">(.*?)</script>', html, re.S).group(1))
keep_card = ("id", "x", "y", "w", "text", "notes", "color")
keep_lane = ("id", "x", "y", "w", "h", "title")
cards = [{k: c[k] for k in keep_card if k in c and not (k == "notes" and not c[k])} for c in data["cards"]]
lanes = [{k: l[k] for k in keep_lane} for l in data["lanes"]]
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump({"format": 1, "cards": cards, "lanes": lanes}, f, indent=2, sort_keys=True, ensure_ascii=False)
print(f"{len(cards)} cards, {len(lanes)} lanes")
