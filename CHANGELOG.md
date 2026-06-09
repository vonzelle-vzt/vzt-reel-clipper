# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`--fit <mode>`** framing control for fitting the (usually 16:9) source into
  the 1080x1920 canvas:
  - `cover` (default) — scale to fill, crop the overflow (best for centered
    talking heads).
  - `contain` — scale the whole frame to fit and pad with black; nothing is cut
    off. Ideal for slides / screen-shares where edge text or charts matter.
  - `blur` — fit the frame sharp and fill the bars with a blurred zoom of itself.

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
