# Compose the per-scene VO at each scene's real start time (from record-narrated.mjs)
# and mux it onto the recorded video -> build-video/tukar-narrated.mp4.
import json, subprocess, os
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
vo = json.load(open("build-video/vo.json"))
sc = json.load(open("build-video/scenes.json"))
video = sc["video"]
scenes = sc["scenes"]  # [{i, startMs}]
if not video or not os.path.exists(video):
    raise SystemExit("no video file in scenes.json: " + str(video))

inputs = ["-i", video]
for m in vo:
    inputs += ["-i", m["file"]]     # vo[i] is ffmpeg input (i+1); video is input 0

parts, labels = [], []
for s in scenes:
    i = s["i"]; delay = int(s["startMs"])
    parts.append(f"[{i+1}]adelay={delay}|{delay}[a{i}]")
    labels.append(f"[a{i}]")
fc = ";".join(parts) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:normalize=0[aout]"

out = "build-video/tukar-narrated.mp4"
cmd = [FFMPEG, "-y", *inputs, "-filter_complex", fc,
       "-map", "0:v", "-map", "[aout]",
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "160k", "-shortest", out]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    print(r.stderr[-2000:])
    raise SystemExit("ffmpeg mux failed")

# report duration
p = subprocess.run([FFMPEG, "-i", out], capture_output=True, text=True)
import re
m = re.search(r"Duration: (\d+:\d+:\d+\.\d+)", p.stderr)
print(f"MUX OK -> {out}  (duration {m.group(1) if m else '?'})")
