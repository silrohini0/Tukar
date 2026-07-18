# Make a TIGHT cut of the narrated demo without re-recording: auto-detect the
# dead-air stretches (a scene that runs far past its VO — the real on-chain
# deposit/withdraw waits), trim them (keeping a short tail after the VO and a
# short lead into the next scene), then re-place each VO clip at its new offset.
# One ffmpeg pass -> build-video/tukar-tight.mp4.
import json, subprocess, re
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
vo = json.load(open("build-video/vo.json"))
sc = json.load(open("build-video/scenes.json"))
video, scenes, recMs = sc["video"], sc["scenes"], sc["recMs"]

BEAT, TAIL, LEAD, MIN_GAP = 700, 2800, 1800, 6000  # ms
voms = {m["i"]: m["ms"] for m in vo}

# For each scene, the moment its narration is done playing.
starts = {s["i"]: s["startMs"] for s in scenes}
order = sorted(starts)
cuts = []  # [cutFrom, cutTo] windows to remove
for a, b in zip(order, order[1:]):
    voEnd = starts[a] + voms.get(a, 0) + BEAT
    gap = starts[b] - voEnd
    if gap > MIN_GAP:
        cuts.append([voEnd + TAIL, starts[b] - LEAD])
cuts.append([recMs + 5000, recMs + 6000])  # sentinel past end (never trims)

# Keep-segments = timeline minus the cut windows.
keep, cur = [], 0
for cf, ct in cuts:
    if ct > cur:
        keep.append([cur, cf])
        cur = ct
keep = [[a, b] for a, b in keep if b > a and a < recMs]

# New scene offset = old offset minus total trimmed time before it.
def shifted(t):
    off = 0
    for cf, ct in cuts:
        if ct <= t:
            off += ct - cf
    return t - off

# ---- build one ffmpeg filter_complex: trim+concat video, adelay+amix VO ----
sec = lambda ms: f"{ms/1000:.3f}"
parts = []
for k, (a, b) in enumerate(keep):
    parts.append(f"[0:v]trim={sec(a)}:{sec(b)},setpts=PTS-STARTPTS[v{k}]")
parts.append("".join(f"[v{k}]" for k in range(len(keep))) + f"concat=n={len(keep)}:v=1:a=0[vout]")

inputs = ["-i", video]
for m in vo:
    inputs += ["-i", m["file"]]
albls = []
for s in scenes:
    i = s["i"]; d = int(shifted(s["startMs"]))
    parts.append(f"[{i+1}]adelay={d}|{d}[a{i}]"); albls.append(f"[a{i}]")
parts.append("".join(albls) + f"amix=inputs={len(albls)}:normalize=0[aout]")
fc = ";".join(parts)

out = "build-video/tukar-tight.mp4"
cmd = [FFMPEG, "-y", *inputs, "-filter_complex", fc,
       "-map", "[vout]", "-map", "[aout]",
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "160k", out]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    print(r.stderr[-2500:]); raise SystemExit("ffmpeg tight-cut failed")

trimmed = sum(ct - cf for cf, ct in cuts if ct < recMs)
p = subprocess.run([FFMPEG, "-i", out], capture_output=True, text=True)
m = re.search(r"Duration: (\d+:\d+:\d+\.\d+)", p.stderr)
print(f"TIGHT OK -> {out}")
print(f"  cut {len([c for c in cuts if c[1] < recMs])} dead-air window(s), trimmed {trimmed/1000:.1f}s")
print(f"  duration {m.group(1) if m else '?'}  (was {recMs/1000:.0f}s)")

# ponytail: assert the tight video is meaningfully shorter than the source
assert trimmed > 20000, f"expected >20s trimmed, got {trimmed/1000:.1f}s"
