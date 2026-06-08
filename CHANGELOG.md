# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-06-07

Initial release.

### Added
- **Speech mode** (default): local WASM Whisper transcription (via the `vintel`
  CLI) or YouTube auto-sub word timing → `claude` CLI picks the best moments →
  9:16 render with **animated word-by-word captions**.
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
