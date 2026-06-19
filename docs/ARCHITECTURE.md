# Architecture

`vzt-reel-clipper` is a small pipeline CLI. One input video goes in; N vertical
captioned clips (and optionally a stitched reel) come out. There is **no paid
API** — transcription runs locally and moment selection uses the `claude` CLI
subscription.

## Pipeline

```
                        ┌───────────── speech mode ─────────────┐
input ─▶ resolve ─▶ ┤                                            ├─▶ render ─▶ clips/*.mp4
        (file/URL)   │  transcribe ─▶ select (claude)            │   (ffmpeg)   (+ reel)
                     └───────────── sports mode ─────────────────┘
                        detect audio-energy peaks (ebur128)
```

1. **resolve** (`src/resolve.js`)
   - Local file → passes straight through.
   - URL → `yt-dlp` downloads the video (auto-uses `~/.deno/bin` as the JS
     runtime) and, when available, the word-level auto-sub `.vtt`.

2. **select** — two strategies produce the same `{start, end, title, reason}` shape:
   - **speech** (`src/select.js`): build a timestamped transcript
     (`src/transcribe.js` — local WASM Whisper via the `vintel` CLI, or a parsed
     YouTube VTT with real word timing) and ask an LLM for the N most clip-worthy
     moments. The LLM call goes through `src/llm.js`, which abstracts two
     subscription CLIs — `claude -p` and `codex exec` (selected with `--engine`).
     Output is sanitized (clamped, length-bounded, de-overlapped).
   - **sports** (`src/sports.js`): no transcript. Read ffmpeg `ebur128`
     momentary loudness across the whole video, find peaks (local maxima above
     `median + sensitivity·1.4826·MAD`), suppress neighbors within `minGap`, and
     drop weak peaks below `max(3, 0.25·topScore)`. Each peak becomes a window
     `[peak − preroll, peak + postroll]` (the crowd reacts *after* the play, so
     pre-roll captures the snap).

3. **render** (`src/render.js`)
   - `scale=1080:1920:force_original_aspect_ratio=increase, crop=1080:1920` fills
     a vertical frame from any source aspect (`--fit cover`, the default; plus
     `contain` and `blur` variants).
   - **`--fit smart`** (subject-tracking pan & scan): `src/reframe.js` plans a
     camera path and render drives the `crop` filter's `x` over time via a
     `sendcmd` script — `sendcmd=f=<clip>.cmd, crop=cropW:cropH:x0:0, scale=…` —
     all in the single render pass. The crop window is full source height,
     9:16-wide, and slides to follow the subject. Falls back to `cover` whenever
     a path can't be planned, so smart is never worse than the default.
   - Captions are burned via the libass `ass` filter:
     - speech → animated word-by-word karaoke (`buildAss`, `src/ass.js`)
     - sports → a static top title banner (`buildTitleAss`)
   - `--reel` concatenates the clips (concat demuxer, stream copy).

## Design notes / gotchas

- **ASS Dialogue fields:** exactly 8 commas precede the `Text` field
  (`Layer,Start,End,Style,Name,MarginL,MarginR,Effect,`). An extra empty field
  leaks a literal leading comma into every caption.
- **Caption windows are global:** each word displays until the *next* word starts
  anywhere in the clip, so adjacent phrases never overlap on screen.
- **ffmpeg filtergraph paths on Windows:** the `ass=` and `ametadata file=`
  options choke on drive-letter colons / backslashes. We run ffmpeg with
  `cwd` set to the output (or a temp) dir and reference files by **bare name**.
- **ebur128 per-frame loudness** is not on stderr in recent ffmpeg builds — only
  a Summary. We get the curve via `ebur128=metadata=1,ametadata=mode=print:file=…`
  and parse `pts_time` + `lavfi.r128.M`.
- **Local transcription is segment-level**, so speech-mode word timings are
  interpolated within each segment. YouTube auto-subs carry true per-word timing.
- **Smart reframe is planning, not pixels** (`src/reframe.js`): it samples by
  *time only* and each detector backend fetches its own pixels — `onnx`
  (`src/detect/onnx.js`) pulls raw letterboxed RGB straight from ffmpeg (no
  image-decode lib; only `onnxruntime-node` + a YOLOv8 `.onnx`), `vintel`
  (`src/detect/vintel.js`) calls the cloud per time-range, `mock` needs nothing.
  Detectors are lazy and fail soft → the whole feature degrades to center
  `cover`. Tracking and framing run **per scene segment** (cuts via
  `select=gt(scene,…)`):
  - **Union framing** (`planTargets`): follows the bounding box of the *salient*
    subjects (dominant track + comparably-sized tracks), so two people are
    framed between them.
  - **Auto-letterbox**: if that union exceeds the 9:16 crop window for most of
    the clip, `planReframe` returns a `recommendFit` (`blur`/`contain`) instead
    of a pan path and the CLI re-renders the whole clip with that fit — no
    one gets cropped out, and it stays a single pass.
  - **Cut snap** (`buildKeyframes`): keyframes are densified *within* each
    segment, so the `crop x` hard-steps at a cut rather than smearing across it.
  - **Audio hold** (`smoothCenters` + `loudnessCurve` from `src/sports.js`):
    a per-frame speech/silence gate from ebur128 damps the follow during pauses
    so the camera holds still instead of drifting.
  - A deadzone + critically-damped follow + max-velocity clamp keep the pan
    operator-smooth. Plans are cached in `.work/reframe-<hash>.json`.

## Reuses the VZT stack

- Transcription leans on the pure-WASM Whisper backend in
  [`vzt-video-intel`](https://www.npmjs.com/package/vzt-video-intel).
- Moment selection uses the `claude` **or** `codex` CLI subscription (same
  zero-API-cost pattern as `tele-build-agent`), behind the `src/llm.js` adapter.
