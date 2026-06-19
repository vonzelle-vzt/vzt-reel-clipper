# How to use vzt-reel-clipper

A step-by-step walkthrough — from zero to a folder full of vertical clips.

---

## 1. One-time setup

You need these installed (most are already on the build machine):

| tool | check it works | needed for |
|---|---|---|
| **ffmpeg** | `ffmpeg -version` | always |
| **node ≥ 20** | `node --version` | always |
| **claude** *or* **codex** CLI (logged in) | `claude --version` / `codex --version` | speech mode (pick one with `--engine`) |
| **vintel** | `vintel --help` | speech mode (local transcription) |
| **yt-dlp** + **deno** | `yt-dlp --version` | only YouTube input |

Then install the tool itself:

```bash
git clone https://github.com/vonzelle-vzt/vzt-reel-clipper.git
cd vzt-reel-clipper
npm install
npm link          # makes `vzt-reel-clipper` and `reelclip` runnable anywhere
```

> Skip `npm link` if you'd rather run it in place with `node bin/vzt-reel-clipper.js …`.

Quick sanity check:

```bash
vzt-reel-clipper --version     # prints 0.1.0
vzt-reel-clipper --help        # lists every option
npm test                       # optional: runs the built-in checks
```

---

## 2. Pick your mode

There are **two modes**. Use the one that matches your footage:

- **`speech`** (default) — anything where people *talk*: podcasts, interviews,
  YouTube videos, lessons, sermons, talking-head reels. It reads the words and
  picks the most clip-worthy moments.
- **`sports`** — game film with *little or no speech*: raw sideline footage,
  hudl-style film, phone video from the stands. It finds the action by listening
  for **loud moments** (crowd, contact, whistles).

---

## 3A. Speech mode (talking videos)

The simplest possible run — point it at a file:

```bash
vzt-reel-clipper "C:\Users\neilv\Videos\podcast.mp4"
```

What happens:

1. It transcribes the video (first ever run downloads a ~75 MB model — one time).
2. `claude` reads the transcript and picks the **5 best moments**, each with a
   catchy title.
3. Each moment is cut, reframed to vertical **9:16**, and gets **animated
   word-by-word captions** burned in.

You'll see the chosen clips printed as it goes, then a `clips\` folder appears.

**Common tweaks:**

```bash
# 8 clips instead of 5
vzt-reel-clipper podcast.mp4 -n 8

# keep clips between 20 and 45 seconds
vzt-reel-clipper podcast.mp4 --min 20 --max 45

# a punchier caption font, custom output folder
vzt-reel-clipper podcast.mp4 --font "Impact" -o my-clips/

# no captions, just the cut + vertical reframe
vzt-reel-clipper podcast.mp4 --no-captions

# use Codex (GPT) to pick the moments instead of Claude
vzt-reel-clipper podcast.mp4 --engine codex
```

**Claude or Codex?** The moment-picking step runs through whichever CLI you're
logged into. `--engine claude` (default) uses your Claude subscription;
`--engine codex` uses your Codex/ChatGPT login. Both are free of per-call API
charges. Override the model with `--model` if you want a specific one
(e.g. `--engine claude --model opus`). Sports mode never calls an LLM, so the
engine choice only applies here in speech mode.

---

## Framing (`--fit`)

Every clip is fit into a vertical **9:16 (1080×1920)** frame. How the (usually
wide) source fills that frame is the `--fit` option:

| `--fit` | what it does | best for |
|---|---|---|
| `cover` *(default)* | scale to fill, **center-crop** the overflow | centered talking heads |
| `contain` | scale the whole frame in, pad with black bars | slides / screen-shares (nothing cut off) |
| `blur` | sharp frame centered, bars filled with a blurred zoom | when black bars look cheap |
| `smart` | **subject-tracking pan & scan** — slides the crop to follow the person | footage where the speaker/action moves around the frame |

```bash
# follow the subject instead of a fixed center crop
vzt-reel-clipper podcast.mp4 --fit smart
```

### Smart reframe setup

`smart` needs a **detector backend** to find the subject. Pick one:

- **`onnx`** *(default — local, free, no cloud)* — runs a YOLOv8 model on your
  machine via `onnxruntime-node`. One-time setup:

  ```bash
  npm i onnxruntime-node                       # native runtime
  # then point smart mode at any YOLOv8 .onnx export, e.g.:
  vzt-reel-clipper podcast.mp4 --fit smart --reframe-model ./yolov8n.onnx
  # or set it once: export VZT_REFRAME_MODEL=/path/to/yolov8n.onnx
  ```

  (Export `yolov8n.onnx` with Ultralytics: `yolo export model=yolov8n.pt format=onnx`.)

- **`vintel`** *(cloud, tracking-aware, billed)* — reuses the `vintel entities`
  command (Meta SAM2 on Replicate). Needs a Replicate token configured in
  vintel. Higher-quality tracking, but not local/free:

  ```bash
  vzt-reel-clipper podcast.mp4 --fit smart --reframe-backend vintel
  ```

**If no backend is available, smart mode never errors — it logs a notice and
falls back to center `cover`.** So `--fit smart` is always safe to try.

Smart mode also handles these automatically:

- **Frames between people.** With two subjects in shot it centers *between*
  them rather than picking one — as long as they fit the 9:16 window.
- **Letterboxes wide shots.** If the subjects are too far apart to fit (a wide
  two-shot), it doesn't crop someone out — it renders the whole clip with the
  `--reframe-letterbox` fit (default `blur`) instead of panning.
- **Hard-cuts at edits.** The camera resets on scene cuts instead of sweeping
  across them.
- **Holds during silence.** It uses audio loudness to keep the camera still in
  pauses (so it doesn't drift on noise). Disable with `--no-reframe-audio-hold`.

Tuning knobs (all optional): `--reframe-smooth <0..1>` (higher = steadier
camera), `--reframe-deadzone <px>` (ignore small jitter), `--reframe-fps <n>`
(detection sample rate), `--reframe-conf <0..1>` (detection threshold),
`--reframe-letterbox <blur|contain|cover>` (fit for un-pannable wide clips),
`--no-reframe-audio-hold` (always pan, even in silence).

To just preview the camera motion without any model, use the synthetic backend:
`--fit smart --reframe-backend mock`.

---

## 3B. Sports mode (game film)

Add `--mode sports`. To also get one stitched highlight reel, add `--reel`:

```bash
vzt-reel-clipper "C:\film\full-game.mp4" --mode sports --reel
```

What happens:

1. It scans the whole game's audio for **loudness peaks** (the crowd/sideline
   reacting to plays).
2. Each peak becomes a clip that starts a few seconds **before** the noise (to
   catch the snap) and ends after it. Each clip gets a **"Big Play N"** banner.
3. With `--reel`, all clips are joined into one `00-highlight-reel.mp4`.

**Common tweaks:**

```bash
# Quiet film and it found too few plays? Lower the threshold (more clips):
vzt-reel-clipper game.mp4 --mode sports --sensitivity 0.7

# Plays getting cut off? Widen the window around each moment:
vzt-reel-clipper game.mp4 --mode sports --preroll 8 --postroll 5

# Cap the number of plays it returns:
vzt-reel-clipper game.mp4 --mode sports -n 10 --reel
```

> `-n` is a **maximum** in sports mode. If the game only had 6 loud moments,
> you get 6 real clips — it won't pad the reel with boring ones.

---

## 4. From a YouTube link (optional)

```bash
vzt-reel-clipper "https://www.youtube.com/watch?v=XXXX" --cookies-from-browser firefox
```

YouTube blocks anonymous downloads, so you must hand it **browser cookies**:

- **Firefox works most reliably:** `--cookies-from-browser firefox`
- **Edge/Chrome often fail** on Windows with a `DPAPI` decrypt error. Either
  close the browser first, or export a `cookies.txt` (the "Get cookies.txt"
  extension) and use `--cookies cookies.txt`.

If it keeps fighting you: just download the video any way you like and run the
tool on the **local file** — that path has none of this hassle.

---

## 5. What you get

```
clips/
  00-highlight-reel.mp4      ← only with --reel
  01-the-secret-nobody-tells-you.mp4
  02-he-turned-5k-into-90k.mp4
  03-...
  clips.json                 ← list of every clip: start/end, title, why it was picked
```

The `.mp4`s are ready to upload to TikTok / Reels / Shorts as-is.

---

## 6. Troubleshooting

| symptom | fix |
|---|---|
| `no speech found …` | It's game/silent film — add `--mode sports`. |
| `ffmpeg … not recognized` | Install ffmpeg and make sure it's on your PATH. |
| `claude CLI failed` | Run `claude` once to confirm you're logged in. |
| Sports mode finds too few clips | Lower `--sensitivity` (e.g. `0.7` or `0.5`). |
| Sports mode finds too many | Raise `--sensitivity` (e.g. `1.3`). |
| Plays start/end mid-action | Increase `--preroll` / `--postroll`. |
| YouTube `Sign in to confirm…` / `DPAPI` | Use `--cookies-from-browser firefox` or a `cookies.txt`. |
| Captions look off / wrong font | Change `--font`, or edit `src/ass.js` for size/color/position. |

---

## 7. Cheat sheet

```bash
# Talking video → 5 captioned shorts
vzt-reel-clipper video.mp4

# Talking video → 8 shorts, 20–45s, custom font
vzt-reel-clipper video.mp4 -n 8 --min 20 --max 45 --font Impact

# Pick moments with Codex instead of Claude
vzt-reel-clipper video.mp4 --engine codex

# Game film → big plays + one highlight reel
vzt-reel-clipper game.mp4 --mode sports --reel

# Game film, quiet audio → more sensitive
vzt-reel-clipper game.mp4 --mode sports --sensitivity 0.7 --reel

# YouTube link
vzt-reel-clipper "https://youtu.be/XXXX" --cookies-from-browser firefox
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it works under the hood.
