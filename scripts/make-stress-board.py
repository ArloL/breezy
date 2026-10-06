"""Writes a 500-card stress board: python3 scripts/make-stress-board.py OUT.breezy"""
import json
import random
import sys

random.seed(1)
words = "Kafka Aufgabe Matches Interview Firmen Ansicht Weiterbildung Reise Plan Review Budget Sprint Kunde Angebot Release Bug Idee".split()
cards, lanes = [], []
for l in range(10):
    lanes.append({"id": f"l{l}", "x": l * 504, "y": 0, "w": 288, "h": 2400, "title": f"Lane {l}"})
    y = 72
    for k in range(30):
        n = random.choice([1, 1, 2, 3, 4])
        text = "\n".join(" ".join(random.choices(words, k=random.randint(1, 3))) for _ in range(n))
        cards.append({"id": f"c{l}_{k}", "x": l * 504 + 24, "y": y, "w": 240, "text": text, "color": random.randint(1, 5)})
        y += (n + 1) * 24 + 24
for k in range(200):
    cards.append({"id": f"f{k}", "x": random.randrange(-100, 100) * 24, "y": random.randrange(110, 200) * 24, "w": 240,
                  "text": " ".join(random.choices(words, k=3)), "color": random.randint(1, 5)})
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({"format": 1, "cards": cards, "lanes": lanes}, f, indent=2, sort_keys=True)
