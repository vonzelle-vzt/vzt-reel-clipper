# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`motion` reframe backend (`src/detect/motion.js`), now the default for
  `--reframe-backend`** (was `onnx`). The `onnx` backend detects PEOPLE, which
  is the wrong subject for wide team-sport film: a 7-on-7 tape shot from the
  stands has ~14 people spread across the field, so the salient union spans
  the whole frame, `planTargets` correctly reports it can't be panned, and
  smart reframe just letterboxes — the detector works and the feature still
  does nothing. `motion` tracks the play instead: it collapses frame-to-frame
  motion into a column energy profile and slides a window the width of the
  9:16 crop to the position holding the most energy, following the ball-side
  cluster. An energy-weighted centroid was tried first and failed on team
  sports — with players moving both directions the average sits mid-field, and
  the measured camera path moved 10px out of a possible 1312. `motion` needs
  no model and no dependency, so `--fit smart` now works out of the box.
  `onnx` remains available (and is the right choice) for talking-head footage,
  and still needs `onnxruntime-node` + a YOLOv8 `.onnx`.
- **Per-shot smart reframe in hype mode.** `--fit smart` previously fell back
  to `cover` for the whole reel in hype mode; it now plans a camera path
  per shot, so each shot gets an independent pan/letterbox decision. A shot
  whose path can't be planned safely falls back to letterboxing or
  centre-crop for that shot alone. Framing/grade run before the speed ramp in
  the render chain, not after — the camera path is driven by `sendcmd` at
  source-relative times, and running it on the time-stretched output would
  fire every keyframe at the wrong moment.
- **Whip-pan transitions.** `score.js` measures each play's direction of
  travel (`motionDirection`, a least-squares slope of the motion centroid)
  over a tight ±1.5s window around the peak — a wide window averages the
  approach and aftermath together and cancels the movement out. `plan.js`
  joins two consecutive action shots with a whip only when both exceed
  `WHIP_MIN_DIR` and travel the same way; everything else is a hard cut on the
  beat. `composite.js` maps a whip to an `xfade` `smoothleft`/`smoothright` at
  0.15s, paired with the planner's whoosh cue. This matches direction of
  travel, not action — it correctly never fires on locked-off tripod footage
  where nothing moves, and true match-cuts between similar actions are not
  implemented.
- **Silent-audio handling and adaptive play spacing** in `score.js`:
  - A silent-but-present audio track is now dropped rather than scored.
    `robustNorm` maps a flat loudness curve to a constant 0.5, which dilutes
    every score while looking like real data — measured on real film, every
    play came back "audio 0.50". Detection: nothing above -70 LUFS, or under
    1.0 LU of range.
  - `minGap` now scales down for short source material (never above the
    profile's own value) — a sport profile's gap assumes raw game film, and
    football's 20s gap applied unscaled to a 75s highlight tape capped the
    reel at 3 plays regardless of how much action it held.
  - `findShots` now prefers CLIP hits inside the expected `region` and only
    backfills from outside it, rather than consulting `region` only in the
    fallback path — previously a "celebration" match near the start of the
    film could be chosen as the closing shot.
- **Gapless timeline.** `plan.js` now closes any leading gap: the intro B-roll
  runway is sized in beats up to the drop but can only be filled if B-roll
  exists, and with none the reel used to open on several seconds of dead air
  (4.45s in testing) and render ~4s shorter than the plan claimed. The
  timeline (shots and sfx cues) is shifted to start at zero and the music is
  offset by the same amount, so the hook still lands exactly on the drop. The
  EDL now carries `contentDuration` alongside `duration`; they must agree.
- **`--mode hype` — music-driven hype reels.** Instead of N standalone clips,
  hype mode produces **one finished reel** cut to a music track you supply:
  cuts land on the beat, the best play lands on the drop, and pacing follows a
  build/break/rebuild arc.
  - **`src/music.js`** derives a beat grid (tempo + phase) and the bass drop
    from the track itself via a fractional-lag comb filter over the onset
    envelope — chosen over plain autocorrelation, which mis-reads tempo by an
    octave whenever the true beat period lands near a half-integer number of
    STFT frames (verified 75–175 BPM, worst error 0.02 BPM).
  - **`src/score.js`** ranks plays by blending motion (0.40), audio loudness
    (0.25) and CLIP semantic context (0.35, via `vintel` when available),
    renormalizing weights when a signal is missing so a silent, vintel-less
    run still scores on motion alone — the production lesson from NextPlay's
    dead-ball rejection work. Loud-but-still moments (whistle, crowd reacting,
    nobody moving) are rejected as dead ball.
  - **`src/plan.js`** builds the edit as an inspectable EDL (`edl.json`): a
    B-roll intro, the best play on the drop, an alternating action/B-roll body
    following a pacing arc (`--arc`), and an outro — all sized in whole beats
    so cuts land on the grid by construction.
  - **`src/composite.js`** renders the EDL in one pass: per-shot framing and
    color grade (`--grade`, `--lut`), speed ramps into the scored peak
    (disable with `--no-ramps`), transitions, an SFX mix from your own sample
    library (`--sfx-dir`, disable with `--no-sfx`), source ambience under the
    music (`--ambience`), and two-pass loudness normalization to -14 LUFS.
  - New flags: `--sport`, `--music` (required), `--sfx-dir`, `--grade`,
    `--lut`, `--arc`, `--duration`, `--no-ramps`, `--no-sfx`, `--ambience`.
  - Sport profiles (`src/profiles.js`) supply per-sport CLIP vocabulary and
    play-window timing for `basketball`, `football`, `flag-football`,
    `soccer`, `lacrosse`, `baseball`, `softball`, `volleyball`, `hockey`,
    `wrestling`, `track`, `tennis`, and `generic` (default).
  - Outputs `00-hype-reel.mp4`, `cover.jpg`, and `edl.json` instead of the
    usual `clips.json` + N clip files.
  - No copyrighted audio ships with the repo — you point `--music` and
    `--sfx-dir` at your own local library.
- **`--proxy <url>`** — passthrough to yt-dlp for the source download (any
  `http://` / `https://` / `socks5://` proxy URL, credentials supported), for
  geo-blocked or IP-throttled networks. Only the download is proxied;
  transcription, selection and rendering stay fully local.
- **Transcript caching.** The slow (~15 min) local WASM-whisper transcript is now
  written to `<out>/.work/transcript.json` and reused on subsequent runs, so
  iterating on the *same* source — changing `--count`, trying `--fit blur`,
  re-rendering — skips straight to selection/render instead of re-transcribing.
  Delete the cache file (or the `.work` dir) to force a fresh transcription.
- **`--fit <mode>`** framing control for fitting the (usually 16:9) source into
  the 1080x1920 canvas:
  - `cover` (default) — scale to fill, crop the overflow (best for centered
    talking heads).
  - `contain` — scale the whole frame to fit and pad with black; nothing is cut
    off. Ideal for slides / screen-shares where edge text or charts matter.
  - `blur` — fit the frame sharp and fill the bars with a blurred zoom of itself.
- **`--fit smart` — subject-tracking auto-reframe.** Instead of a fixed
  center-crop, smart mode slides a full-height 9:16 crop window to follow the
  subject. It plans a smoothed virtual-camera path (`src/reframe.js`) and drives
  ffmpeg's `crop` via `sendcmd` in the single render pass. Behaviours:
  - **Union framing** — centers *between* two subjects when they fit the frame.
  - **Active-speaker** — in a wide two-shot it follows the *talker*, estimated
    from mouth-region motion gated by audio (with dwell/margin hysteresis and a
    cut at each speaker switch). A motion proxy, not AV lip-sync; disable with
    `--no-reframe-active-speaker`.
  - **Auto-letterbox** — when there's no clear talker, clips too wide to pan
    re-render whole as `--reframe-letterbox` (default `blur`) instead of cropping
    someone out.
  - **Cut snap** — the camera hard-resets at scene cuts (no pan across an edit).
  - **Audio hold** — uses ebur128 loudness to keep the camera still during
    silence; disable with `--no-reframe-audio-hold`.
  - Pluggable **detector backends**: `onnx` (default — local YOLOv8 via
    `onnxruntime-node`, no paid API; `--reframe-model` / `VZT_REFRAME_MODEL`),
    `vintel` (cloud SAM2 via the `vintel entities` command), and `mock`
    (synthetic, for preview). Backends are lazy and fail soft — if none is
    available, smart mode logs a notice and falls back to center `cover`, so
    `--fit smart` is always safe to try.
  - Tuning: `--reframe-backend`, `--reframe-model`, `--reframe-conf`,
    `--reframe-fps`, `--reframe-smooth`, `--reframe-deadzone`,
    `--reframe-letterbox`, `--no-reframe-audio-hold`. Camera paths are cached in
    `<out>/.work/reframe-<hash>.json`.
  - *Not yet:* true audio-visual active-speaker detection (AV lip-sync, e.g.
    TalkNet) — the talker pick is a mouth-motion proxy, not a trained AV model.

### Changed
- **Bundled ffmpeg via `ffmpeg-static`.** ffmpeg is now resolved from the bundled
  static build (which ships **libass**, so caption burning works even where the
  system ffmpeg was compiled without it) rather than requiring it on `PATH`.
  ffprobe still resolves from `PATH`. Both honour `VZT_FFMPEG` / `VZT_FFPROBE`
  overrides. This makes the full `npm test` suite (caption renders included) run
  on machines whose system ffmpeg lacks libass.

### Fixed
- **Paths with spaces** no longer break local transcription, LLM selection, or
  YouTube download. `exec()` runs `vintel`/`claude`/`codex`/`yt-dlp` through a
  shell on Windows, where Node does not quote args — so an input like
  `…/2026 Matrix Bootcamp/Day 1 - EMAS.mp4` was split at the first space and the
  tool only saw `…/2026.`. Args are now quoted via a new `quoteArg()` helper
  whenever a command runs in shell mode. (ffmpeg/ffprobe use array args and were
  unaffected.)

## [0.1.0] — 2026-06-07

Initial release.

### Added
- **Speech mode** (default): local WASM Whisper transcription (via the `vintel`
  CLI) or YouTube auto-sub word timing → an LLM picks the best moments → 9:16
  render with **animated word-by-word captions**.
- **Pluggable selection engine** (`--engine claude|codex`): moment selection runs
  through either the `claude` or `codex` CLI subscription via `src/llm.js`. No API key.
- **Sports mode** (`--mode sports`): no-speech selection for game film. Detects
  plays via **audio-energy peaks** (ffmpeg `ebur128` momentary loudness), with a
  median+MAD threshold, non-maximum suppression, and weak-peak dropping so quiet
  games yield fewer real clips instead of padding.
- **`--reel`**: stitch the produced clips into one highlight reel (concat demuxer).
- YouTube input via `yt-dlp` (auto-detects `deno` JS runtime; cookie support).
- Static top-banner titles for sports clips (`buildTitleAss`).
- `clips.json` manifest with start/end, titles, and selection reasons.
- Self-contained smoke test suite (`npm test`).

### Notes
- No paid API: transcription is local, moment selection uses the `claude` CLI
  subscription.
- Local transcription is segment-level; word caption timing is interpolated
  within each segment (YouTube subs give true word-level timing).
