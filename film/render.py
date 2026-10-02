"""HermesCity film render: GPU frame capture (headed Edge via Playwright) -> H.264 master + 720p web cut + poster,
muxed with audio/mix.m4a. Also writes the README banner.

Env:   PAGE (film.html | tutorial.html | play-promo.html), NAME (output name), AUDIO (audio track), POSTER_T (poster time),
       PRESET (x264 preset for the capture, default slow; veryfast when memory is tight)
Usage: python render.py <base url of the running site, e.g. http://localhost:8150> [ss=1.5] [mb=2]
Env:   FFMPEG (path to ffmpeg, default "ffmpeg")"""
import base64
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

FF = os.environ.get("FFMPEG", "ffmpeg")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
BASE = sys.argv[1].rstrip("/")
SS = sys.argv[2] if len(sys.argv) > 2 else "1.5"
MB = sys.argv[3] if len(sys.argv) > 3 else "2"
FPS = 30
PAGE = os.environ.get("PAGE", "promo.html")
NAME = os.environ.get("NAME", "hermescity-promo")
AUDIO = os.environ.get("AUDIO", os.path.join(HERE, "audio", "promo_ambience.m4a"))
POSTER_T = os.environ.get("POSTER_T", "3.5")
os.makedirs(OUT, exist_ok=True)
raw = os.path.join(OUT, f"{NAME}_video.mp4")
t0 = time.time()

with sync_playwright() as p:
    b = p.chromium.launch(headless=False, channel="msedge", args=[
        "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--window-position=40,40", "--window-size=1300,860",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"])
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    pg.on("console", lambda m: m.type == "error" and print("CONSOLE", m.text, flush=True))

    # README banner: the homepage's view of the town (tour only)
    if False:
      pg.goto(f"{BASE}/film.html?banner=1&ss=2", timeout=180000)
      pg.wait_for_function("document.getElementById('status').textContent === 'banner'", timeout=600000)
      d = pg.evaluate("document.getElementById('out').toDataURL('image/jpeg', 0.92)")
      open(os.path.join(OUT, "header.jpg"), "wb").write(base64.b64decode(d.split(",", 1)[1]))
      print("banner written", flush=True)

    pg.goto(f"{BASE}/{PAGE}?render=1&ss={SS}&mb={MB}", timeout=180000)
    pg.wait_for_function("window.__film", timeout=600000)
    dur = pg.evaluate("window.__film.DUR")
    n = int(dur * FPS)
    ff = subprocess.Popen([FF, "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                           "-c:v", "libx264", "-preset", os.environ.get("PRESET", "slow"), "-crf", "16", "-pix_fmt", "yuv420p", raw], stdin=subprocess.PIPE)
    for i in range(n):
        d = pg.evaluate("t => { __film.seek(t); return document.getElementById('out').toDataURL('image/jpeg', 0.95); }", i / FPS)
        ff.stdin.write(base64.b64decode(d.split(",", 1)[1]))
        if i % 150 == 0:
            print(f"frame {i}/{n} {time.time() - t0:.0f}s", flush=True)
    ff.stdin.close()
    ff.wait()
    b.close()

mix = AUDIO
master = os.path.join(OUT, f"{NAME}.mp4")
web = os.path.join(OUT, f"{NAME}-720.mp4")
poster = os.path.join(OUT, f"{NAME}.jpg")
subprocess.run([FF, "-y", "-loglevel", "error", "-i", raw, "-i", mix, "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", master], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-i", master, "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "22",
                "-maxrate", "4M", "-bufsize", "8M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", web], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-ss", POSTER_T, "-i", master, "-frames:v", "1", "-vf", "scale=1600:900:flags=lanczos", "-q:v", "3", poster], check=True)
os.remove(raw)
print(f"DONE {time.time() - t0:.0f}s master={os.path.getsize(master)} web={os.path.getsize(web)}", flush=True)
