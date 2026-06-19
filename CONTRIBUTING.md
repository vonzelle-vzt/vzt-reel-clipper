# Contributing

Thanks for taking a look. This is a small, dependency-light Node CLI — easy to
hack on.

## Setup

```bash
git clone https://github.com/vonzelle-vzt/vzt-reel-clipper.git
cd vzt-reel-clipper
npm install
npm test          # self-contained, generates its own ffmpeg fixtures
```

You need **ffmpeg/ffprobe** on PATH and **node ≥ 20**. For the full speech
pipeline you also need the `claude` and `vintel` CLIs; for the YouTube path,
`yt-dlp` + `deno`. See the README for details.

## Project layout

| file | responsibility |
|---|---|
| `bin/vzt-reel-clipper.js` | entry point |
| `src/cli.js` | arg parsing + pipeline orchestration |
| `src/resolve.js` | input → local file (local passthrough / yt-dlp) |
| `src/transcribe.js` | local WASM transcript + YouTube VTT word parser |
| `src/select.js` | speech-mode moment selection via `claude` |
| `src/sports.js` | sports-mode audio-energy peak detection + shared `loudnessCurve` |
| `src/ass.js` | ASS subtitle generation (karaoke + title banner) |
| `src/render.js` | ffmpeg cut + 9:16 reframe (cover/contain/blur/smart) + caption burn + reel stitch |
| `src/reframe.js` | `--fit smart` camera-path planner (track → union frame → smooth → keyframes) |
| `src/detect/onnx.js` | local YOLOv8 subject detector (onnxruntime-node + raw-RGB from ffmpeg) |
| `src/detect/vintel.js` | optional cloud subject detector (`vintel entities` / SAM2) |
| `src/util.js` | exec/ffprobe/format helpers |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow.

## Conventions

- Plain JavaScript (ESM), no build step. Keep it that way unless there's a strong reason.
- Match the surrounding comment density and naming.
- Any new behavior should come with a check in `test/smoke.test.mjs` — keep it
  self-contained (generate fixtures with ffmpeg, no network, no committed media).
- Run `npm test` before opening a PR.

## Good first issues

- Word-level local ASR backend (replace segment-interpolation for frame-perfect captions).
- Fuse `vintel` visual scene/motion detection with audio peaks in sports mode.
- Caption theme presets (font/color/position) and a `--theme` flag.
- **Active-speaker reframe**: `--fit smart` already follows the talker in a
  two-shot via a *mouth-motion proxy* (`selectActiveSpeaker` in `src/reframe.js`).
  Upgrade it to true audio-visual lip-sync (e.g. TalkNet / Light-ASD) for
  robustness when both subjects move.
- A `python`/Ultralytics reframe backend (highest-quality YOLOv11 + ByteTrack).
