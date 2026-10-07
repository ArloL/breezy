"""Summarises build/bench.jsonl as means with 95 % confidence intervals per label and board."""
import collections
import json
import statistics as st
import sys

T = {2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262}
rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "build/bench.jsonl")]
groups = collections.defaultdict(list)
for r in rows:
    groups[(r["label"], r["board"])].append(r["r"])
keys = ["launch_ms", "idle.mb", "hidden.mb", "peak_mb", "zoom.p95_ms", "zoom.max_ms", "pan.p95_ms", "pan.max_ms", "drag.p95_ms", "drag.max_ms", "type.p95_ms", "type.max_ms", "zoom.cpu_ms"]

def ci(xs):
    m = st.mean(xs)
    return f"{m:.1f}" if len(xs) < 2 else f"{m:.1f} ± {T.get(len(xs), 2) * st.stdev(xs) / len(xs) ** .5:.1f}"

print("label | board | n | " + " | ".join(keys))
for (label, board), rs in groups.items():
    vals = []
    for k in keys:
        a, _, b = k.partition(".")
        vals.append(ci([r[a][b] if b else r[a] for r in rs]))
    print(f"{label} | {board} | {len(rs)} | " + " | ".join(vals))
