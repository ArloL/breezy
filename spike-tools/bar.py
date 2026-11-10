import json, subprocess, sys
mov, scale = sys.argv[1], 2
info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:frame=pts_time", "-of", "json", mov]))
w, h = info["streams"][0]["width"], info["streams"][0]["height"]
times = [float(f["pts_time"]) for f in info["frames"]]
raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", mov, "-f", "rawvideo", "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-"])
size, row = w * h * 3, (h // 2) * w * 3
out = []
for i, t in enumerate(times):
    fr = raw[i * size + row: i * size + row + w * 3]
    x = next((j for j in range(w) if fr[3 * j] > 180 and fr[3 * j + 1] < 80 and fr[3 * j + 2] < 80), None)
    out.append([round(t * 1000, 1), None if x is None else x / scale])
print(json.dumps(out))
