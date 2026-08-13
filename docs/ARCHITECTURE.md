# Architecture

`vzt-reel-clipper` is a small pipeline CLI. One input video goes in; N vertical
captioned clips (and optionally a stitched reel) come out. There is **no paid
API** — transcription runs locally and moment selection uses the `claude` CLI
subscription. A third mode, `--mode hype`, inverts the N-clips shape into one
music-driven reel — see [Hype pipeline](#hype-pipeline---mode-hype) below.

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
     runtime) and, when available, the word-level auto-sub `.vtt`. An optional
     `--proxy <url>` is forwarded verbatim to yt-dlp — this download is the
     pipeline's only network touch; every later stage is local.

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
  *time only* and each detector backend fetches its own pixels — `motion`
  (`src/detect/motion.js`, the default) pulls low-res grayscale frames from
  ffmpeg and needs neither a model nor an extra dependency, `onnx`
  (`src/detect/onnx.js`) pulls raw letterboxed RGB straight from ffmpeg (no
  image-decode lib; only `onnxruntime-node` + a YOLOv8 `.onnx`), `vintel`
  (`src/detect/vintel.js`) calls the cloud per time-range, `mock` needs nothing.
  Detectors are lazy and fail soft → the whole feature degrades to center
  `cover`. Tracking and framing run **per scene segment** (cuts via
  `select=gt(scene,…)`):
  - **Motion backend** (`src/detect/motion.js`, default): the `onnx` backend
    detects PEOPLE, which is the right subject for a talking head and the wrong
    one for wide sports film — a 7-on-7 tape shot from the stands has ~14
    people spread across the field, so the salient union spans the whole frame,
    `planTargets` correctly reports it can't be panned, and smart reframe just
    letterboxes. `motion` tracks the play instead of a person: it collapses
    frame-to-frame `|Δluma|` into a per-column energy profile, then slides a
    window the width of the 9:16 crop and takes the position holding the most
    energy, following the ball-side cluster. An energy-weighted **centroid**
    was tried first and doesn't work on team sports — with players moving both
    directions the average sits mid-field almost every frame; measured on real
    7-on-7 film, the resulting camera path moved 10px out of a possible 1312,
    a centre crop wearing a tracker's clothes. `onnx` remains available and is
    the right choice for talking-head footage where a person is the subject.
  - **Union framing** (`planTargets`): follows the bounding box of the *salient*
    subjects (dominant track + comparably-sized tracks), so two people are
    framed between them.
  - **Active-speaker** (`selectActiveSpeaker`): when the union is too wide to
    pan, instead of letterboxing it follows the *talker* — a cheap low-res
    grayscale pass (`motionGrid`) measures each subject's mouth-region luma
    change (`regionLuma`) over time; the most active subject (gated by the audio
    speech curve, with dwell + margin hysteresis) is followed, snapping at
    speaker switches. A motion proxy, not AV lip-sync.
  - **Auto-letterbox**: if there's no clear talker (no motion / no audio),
    `planReframe` returns a `recommendFit` (`blur`/`contain`) instead of a pan
    path and the CLI re-renders the whole clip with that fit — no one gets
    cropped out, and it stays a single pass.
  - **Cut snap** (`buildKeyframes`): keyframes are densified *within* each
    segment, so the `crop x` hard-steps at a cut rather than smearing across it.
  - **Audio hold** (`smoothCenters` + `loudnessCurve` from `src/sports.js`):
    a per-frame speech/silence gate from ebur128 damps the follow during pauses
    so the camera holds still instead of drifting.
  - A deadzone + critically-damped follow + max-velocity clamp keep the pan
    operator-smooth. Plans are cached in `.work/reframe-<hash>.json`.

## Hype pipeline (`--mode hype`)

Speech and sports mode both produce N independent clips. Hype mode produces
**one edited reel**, and the pipeline shape changes accordingly: analysis feeds
an EDL (edit decision list), and a single compositor renders the whole EDL in
one pass rather than rendering N clips independently.

```
music.js ──┐
score.js ──┼──▶ plan.js (EDL) ──▶ composite.js ──▶ 00-hype-reel.mp4
intel.js ──┘        "the edit is data"
```

The middle step is the load-bearing idea: `plan.js` is a pure function from
(music analysis, scored plays, B-roll candidates) to a JSON edit plan — no I/O,
fully unit-testable without rendering a frame. Every rule in the editing
doctrine (hook on the drop, cuts on the beat, alternate action/B-roll, ramp the
impact) becomes an assertion on that plan instead of something buried in
ffmpeg args.

`--fit smart` plans a camera path **per shot**, in `bin/vzt-reel-clipper.js`
after the EDL is built: it calls `planReframe` once per `edl.shots[i]` over
that shot's own `[srcStart, srcEnd]` window, so each shot gets an independent
pan/letterbox decision instead of one fit for the whole reel. A shot whose path
can't be planned safely (`rf.recommendFit`, or `planReframe` returning nothing)
falls back to letterboxing or centre-crop for that shot alone.

### music.js — beat grid via comb filter, not autocorrelation

A hype reel is driven by the track: cuts land on beats, the best play lands on
the drop, shot durations are whole bars. That needs a beat grid, derived from
the track itself (PCM → STFT → spectral flux → onset envelope) with no
dependency added — the FFT, tempo estimation and grid layout are all
hand-rolled in `src/music.js`.

**Why not autocorrelation for tempo.** It was tried first and produces octave
errors whenever the true beat period lands near a half-integer number of STFT
frames — 120 BPM is 21.53 frames at this hop size, 140 BPM is 18.46. Alternate
onsets then split unevenly across frame boundaries, which amplitude-modulates
the envelope with a spurious two-beat cycle, and autocorrelation peaks at 2×
the true period: 120 BPM read as 60, 140 as 70. No tempo prior rescues this —
the wrong lag genuinely correlates ~1.6× stronger.

The fix is a **fractional-lag comb filter**: each candidate (period, phase)
predicts a beat grid, and the grid is scored as an F1-style product of
**coverage** (captured onset energy ÷ total — punishes too-*slow* candidates
that leave onsets unexplained, which is what kills the octave error) and
**precision** (captured ÷ number of grid points — punishes too-*fast*
candidates whose extra beats land on silence). Lags are fractional with
linearly-interpolated envelope lookups, so both the period and the phase come
out of the same search, accurate to sub-frame resolution — verified against
synthetic click tracks across 75–175 BPM, worst error 0.02 BPM.

The bass drop is detected separately, off the low-band (<250 Hz) energy: the
largest *sustained* jump (checked against a hold window so a single kick can't
win), then snapped onto the downbeat grid so it stays on-beat.

### score.js — multi-signal play scoring

The original sports-mode scorer ranked plays by audio energy (`ebur128`) alone.
NextPlay hit the wall in production and documented it in
`src/lib/highlights/dead-ball.ts`: *"Parent-shot phone film has no crowd mic, so
every event scores a neutral 0.5 and the audio rescue never fires."* Silent
sideline footage has no peaks for audio-only scoring to find.

So `score.js` blends **four** signals, weighted `motion 0.30 / burst 0.25 /
audio 0.20 / context 0.25` (`WEIGHTS` in `src/score.js`). The motion/audio/
context split started from NextPlay's validated production numbers; `burst`
was added afterwards and the rest rescaled to make room for it.

`burst` — the half-wave-rectified derivative of the motion curve — is what
separates a play from milling about. Raw motion magnitude cannot: both are
"some pixels changed". A play *begins* with a near-simultaneous acceleration
and then sustains, while a sideline crowd is flat. It carries the weight
`context` cannot whenever semantic search is unavailable or degenerate, which
on this footage is always.

Any signal can be missing (no audio track, no `vintel` on PATH); when
one is, its weight is **renormalized across the survivors** rather than
silently dragging every score toward zero, which is what keeps a silent,
vintel-less run working on motion alone.

**Dead-ball rejection** is the other half of the NextPlay lesson: the loudest
moment is often the *dead* one (the whistle, the crowd still roaring while
everyone stands around). The heuristic is "loud but still" — high audio, low
motion — with thresholds derived from *this video's own* score distribution
(percentile, not a fixed cutoff) because `robustNorm` maps scores into roughly
[0,1] without actually reaching the ends. The percentile bounds are
**inclusive**, deliberately: a static stretch of footage produces a plateau of
identical motion values sitting exactly ON the threshold, and a strict `<`
would leave the entire dead stretch one float above the cutoff, rejecting none
of it (measured case: motion 0.388 against a 0.38758 floor).

**Silent-but-present audio is dropped, not scored.** A track with an audio
stream but no real sound still produces a loudness curve, and `robustNorm`
maps a flat line to a constant 0.5 — not a signal, a constant that dilutes
every score equally while looking like real data. Measured on real 7-on-7
film: every play came back "audio 0.50". `scorePlays` now checks the curve
before using it — nothing above -70 LUFS (below any usable recording,
including a distant crowd mic), or under 1.0 LU of range — and if either
holds, drops the audio signal entirely so its weight renormalizes onto motion
and context instead.

**`minGap` scales to the source, capped at the profile value.** A sport
profile's `minGap` assumes raw, uncut game film where plays sit tens of
seconds apart. Applying football's 20s gap unscaled to a 75s highlight tape
caps the reel at 3 plays regardless of how much action the tape holds.
`scorePlays` scales the requested gap down for short material
(`Math.min(requested, Math.max(3, duration / (count * 1.5)))`) but never raises
it above the profile's own value.

**`motionDirection`** (a least-squares slope of the motion centroid) measures
which way a play travels, over a **tight ±1.5s window around the peak**
(`SHOT_DIR_WINDOW`) rather than the full preroll/postroll candidate window — a
wide window averages the approach and the aftermath into the same number and
cancels the movement out; measured on real film, the wide window under-read
direction by 2-6x and no whip transition ever qualified (see `plan.js` below
for how the planner consumes this).

**`findShots`** (B-roll / outro candidates) now prefers CLIP hits **inside**
the expected `region` and only backfills from outside it, rather than
consulting `region` only in the fallback path. Previously a "celebration"
match near the start of the film could be chosen as the closing shot — observed
on real film, where both outro picks landed in the first 6 seconds.

### plan.js — the EDL

Shots are allocated in **whole beats**, not seconds, so cuts land on the grid
by construction — there is no snapping step that can be off by a frame. The
hook (best-scored play) is placed on the drop, after a short B-roll intro; this
is the single biggest change from the old chronological-sort sports mode, which
buried the best play wherever it happened to occur.

Pacing follows a **rollercoaster arc** (build → deliberate slow-down → rebuild
to a climax) rather than uniform clip lengths, which is what makes fixed
7s-preroll/4s-postroll sports clips feel flat back to back. Critically, the arc
is driven by progress through the **material** (how many plays/B-roll shots are
left), not by position in the song: mapping it to the beat timeline instead
would compress the curve whenever there's less footage than song, and the body
loop would exit before the arc ever reaches its rebuild-to-climax tail.

**Whip-pan pairing.** Two consecutive `action` shots are joined with
`transition: "whip"` only when both exceed `WHIP_MIN_DIR` (0.02) and travel the
same way (`Math.sign` agrees on `score.js`'s `motionDir`); everything else is a
hard cut on the beat, which is the primary device anyway. This reads as the
"natural whip pan" of the editing doctrine rather than a transition pulled from
a pack — it correctly never fires on locked-off tripod footage where nothing
moves. It matches *direction of travel only*; true match-cuts between two
similar actions are not implemented. `composite.js` maps `"whip"` to an `xfade`
`smoothleft`/`smoothright` (see the composite.js gotchas below) paired with a
whoosh SFX cue.

**Gapless timeline.** The intro B-roll runway is sized in beats up to the drop,
but can only be filled if B-roll candidates exist. With none, the hook still
starts at the drop and the reel opens on several seconds of nothing — 4.45s of
dead air in testing, and since the renderer just concatenates shots, the
finished reel came out ~4s shorter than the plan claimed. `plan.js` now shifts
the whole timeline (shots and sfx cues) to start at zero and offsets the
**music** by the removed amount (`music.offset`), so the hook still lands
exactly on the drop — the reel just opens on it instead of before it. The EDL
now also carries `contentDuration` (the sum of shot durations) alongside
`duration` (end of the last shot); the two must agree, since a mismatch is
exactly the symptom this fix corrects.

### composite.js — assembly gotchas worth recording

- **`-ss`/`-t` must both precede `-i`.** As a *trailing* option, `-t` gets
  consumed by ffmpeg as an option for the *next* input (the `anullsrc` silence
  generator) instead of trimming the video — every shot would silently run to
  the end of the source file.
- **Timestamps are rebased to zero before trims.** `-ss` does not guarantee the
  decoded stream's PTS starts at zero — where the seek lands relative to a
  keyframe can leave source-absolute timestamps on the frames, and a
  `trim=0.3:0.75` against those selects the wrong range entirely. Cheap
  insurance, only visible on some seek offsets.
- **Two-pass loudnorm, not one-pass.** The single-pass form is only a rough
  estimate; it measured the reel at -16.2 LUFS, over 2 LU quiet against
  everything else in a feed. Pass one measures the finished mix, pass two
  applies those exact measurements against the -14 LUFS streaming target.
- **The xfade-padding identity.** With `xfade`, `out = A + B - d`. Padding each
  shot's tail by its *next* transition's duration makes every `d` cancel across
  the chain, so the offset of join `i` collapses to exactly `shots[i].at` — no
  running total to track, no drift between the plan's beat grid and the
  rendered timeline. Hard cuts inside an xfade chain use a one-frame fade so the
  same arithmetic holds uniformly for both cut types.
- **Framing/grade run BEFORE the speed ramp, never after.** A smart-reframe
  camera path is driven by `sendcmd` at *source*-relative times. The speed ramp
  time-stretches the shot with `setpts=PTS/speed`; if framing ran on the
  stretched output, every `sendcmd` keyframe would fire at the wrong moment.
  Running framing on the unramped source first keeps the camera path's
  timestamps meaningful.
- **Whip-pan transitions** map `shot.transition === "whip"` to ffmpeg `xfade`
  `smoothleft` (leftward) or `smoothright` (rightward) at 0.15s
  (`transitionSpec`, `WHIP_D`), paired with the planner's whoosh SFX cue —
  see [plan.js — the EDL](#planjs--the-edl) below for how a shot pair qualifies.

`renderShot` (composite.js) and `renderClip` (`src/render.js`) share
`buildFitFilter`, exported from `src/render.js` — framing (`cover` / `contain`
/ `blur` / smart-reframe crop) is one implementation used by both the
per-clip and the hype-reel render paths.

## Watching video (`reelclip watch`)

`src/watch.js` + `src/vision.js`. The tool was blind for a long time —
selection ran entirely off motion and audio statistics, and three separate
failures on real footage were invisible to every metric while obvious in a
single frame: a "highlight reel" that was actually a warm-up session with no
throws or catches in it, a semantic search that reported confident matches
that were uniform noise, and a scorer that picked players standing with their
hands on their hips because a sideline body near the lens outweighs a
receiver fifty yards downfield in pixel terms.

`watchVideo` fixes this by fusing two independent halves per frame:

- **Measurement** (`src/inspect.js`, `src/score.js`, `src/intel.js`) — cheap,
  deterministic, never skipped: frame extraction, `motionCurve`, scene cuts,
  `analyzeMusic`. This is the half that works with no model installed.
- **Vision** (`src/vision.js`) — `extractFrames` samples the source at
  `--density` fps into numbered JPEGs, then `labelFrames` hands their
  **paths** to `claude -p`, which `Read`s them and returns a closed-enum
  label per frame (`action | broll | celebration | crowd | unclear`) plus a
  short factual description. The mechanism is ported wholesale from
  `vzt-reel-studio` (`src/llm.js`'s `VISION_PREFIX` + `src/verify/tier1.js`'s
  batching), which already proved it in that fleet:
  - the invocation prefix (`VISION_PREFIX` in `src/vision.js`) is **frozen**
    so separate processes share the one-hour prompt cache; only `--model`,
    `--json-schema` and the piped prompt vary between calls.
  - the prompt goes over **stdin**, never argv.
  - frames are batched (`BATCH_SIZE = 20`) rather than one call per frame.
  - `--json-schema` forces the closed-enum answer (`WATCH_SCHEMA`), so the
    result can be counted by code instead of parsed out of prose.
  - results are matched back to requested frames **by timestamp**, not array
    position — a short answer (19 entries for 20 frames) would otherwise
    silently shift every later label onto the wrong moment.
  - bulk labelling runs on `haiku`, because cost is not the obstacle: a
    512px JPEG is ~197 vision tokens (`TOKENS_PER_FRAME`), so `--density`
    `normal` (1 fps) over a 4-minute video is ~47k tokens and a 64s clip at
    `skim` (0.5 fps) is ~6k — cheaper than most single file reads.

Vision degrades to measurement-only rather than failing the run (`available()`
caches whether `claude` is on PATH; `--no-describe` skips it deliberately for
zero tokens) — the same fail-soft contract as `src/intel.js`.

The two halves are fused in `watchVideo`'s `timeline`: `label` and
`description` come from vision, `motion` from the measurement curve
(nearest-timestamp lookup), so `t=12.0` in the output timeline is `{label:
"action", motion: 0.81, ballVisible: true}` rather than two disconnected
signals a caller has to reconcile.

`summarize()` reports the resulting verdict — "is this file usable as game
film at all?" — and is deliberately careful never to print a percentage for
content it did not measure: skipping the vision pass prints "content not
assessed", never "0% action", because not-measured is not zero. On real
7-on-7 game film this reported 25% action / 69% b-roll, against 13% action on
a warm-up file from the same session — the discrimination this module exists
to make.

## Learning a style (`reelclip learn`)

`src/learn/index.js` (I/O: fetch, cut detection, vision, cleanup) +
`src/learn/shots.js` (pure-ffmpeg shot measurement) + `src/learn/style.js`
(pure derivation, no I/O — measurements in, style profile out, so every
derived number is asserted in tests without downloading anything).

`learnStyle` fetches the reference, finds its cuts (`detectCuts` — prefers
`vintel scenes`, falls back to raw ffmpeg scene detection), measures each
shot (`analyzeShots` — duration, mean motion, and ramp detection via
`duplicateRate`, the tell for non-interpolated slow motion: halving playback
on 30fps footage shows every frame twice, so a ramped shot's duplicate rate
sits far above a normal one), and — unless `--no-describe` — classifies one
frame per shot with the same `labelFrames` vision pass `watch` uses. The
downloaded reference video is then **deleted**; only the derived numbers and
one contact sheet are kept (`!opts.keepVideo && videoPath.startsWith(workDir)`
guards against deleting a file the caller didn't actually download).

`deriveStyle` (`src/learn/style.js`) turns those measurements into the style
profile:

- **`beatAlignment`** reports the fraction of cuts landing within a ±60ms
  tolerance of the nearest beat, alongside **`chance`** — the probability a
  *random* cut would land "on beat" by the same tolerance
  (`2·tol/period`, ≈24% at 120 BPM) — and **`lift`**, the difference. The raw
  percentage alone is misleading without the baseline it's being compared to.
- **`fitArc`** correlates the shot-length sequence (inverted into "energy",
  short shot = high energy) against each built-in arc's expected shape and
  picks the best-correlated one. Below `ARC_CONFIDENCE` (0.4) the fit is not
  meaningfully better than noise — measured on a known-rollercoaster
  reference it picked "build" at 0.185, a label wearing noise's clothes — so
  the function reports `confident: false` and falls back to the neutral
  `steady` arc rather than asserting a shape it did not detect.

`styleToPlanOpts` maps a loaded style onto `planEdit`'s own option shape
(`arc`, `minShotBeats`, `grade`; `rampCount` resolves separately via
`resolveRampCount` once the play count is known, since the style stores a
*fraction* but the planner wants a *count*). **An explicit CLI flag always
wins** over the style — `styleToPlanOpts`'s `take()` helper checks
`explicit[key] != null` before falling back to the style's value — and the
returned `provenance` records where each resolved value came from
(`"flag"` or `"style"`) so `cli.js` can print it:
`style "roundtrip" → arc:flag minShotBeats:style rampCount:style`. A style
silently overriding a typed flag would be the same class of problem as
reporting a number nobody measured.

**Known limitation:** shot-boundary detection (`detectCuts`) misses cuts
between visually similar shots. A round-trip on the project's own 9-shot
reference reel recovered 7 of 9 shots.

## Apple Music tempo/drop (`src/applemusic.js`)

Apple Music subscription files are DRM-protected; ffmpeg cannot decode them
and this module makes no attempt to circumvent that. It instead pulls the two
numbers a hype edit needs from sources that are legitimately reachable:

- **Tempo** — `searchTracks` hits the public iTunes Search API
  (`itunes.apple.com/search`), which returns a DRM-free 30-second AAC preview
  for almost every catalog track. `tempoFromPreview` downloads that preview
  and runs it through `music.js`'s existing onset/tempo estimator — no new
  tempo-detection code, just a new audio source for the one that already
  exists.
- **Drop** — `nowPlaying()` reads the Music app's currently-playing track and
  playhead position via AppleScript (`osascript`, macOS only; error `-1728`
  — "can't get current track" — is treated as the expected "nothing is
  playing" state, not a failure). The workflow is: cue the real track in
  Music, scrub to the drop, then run the command that calls `nowPlaying()`.

Two honesty behaviours in `tempoFromPreview`:

- **Octave sanity check.** A 30-second excerpt with a busy hi-hat pattern
  commonly reads at double the true tempo — measured 198.8 BPM on a track
  that is really about half that. Any BPM above 175 or below 70 triggers a
  warning naming the halved/doubled alternative and pointing at `--bpm` to
  override, because a doubled tempo halves every shot in the edit and looks
  like a pacing bug later rather than a tempo bug now.
- **The preview's own `drop` is discarded.** `analyzeMusic` still detects a
  bass-drop timestamp inside the 30s preview, but that timestamp is relative
  to a ~30s excerpt from the *middle* of the song and corresponds to nothing
  in the full track's timeline. BPM is kept (produced music holds a fixed
  tempo grid across the whole track, so a 30s sample is representative); drop
  must come from `--drop` or `nowPlaying()` instead.

`cli.js`'s `--apple-music` is mutually exclusive with `--music` and `--bpm`
(exactly one tempo source), and — like `--bpm` — produces a synthetic beat
grid with no underlying audio file, so the render has nothing to mix and
exports a silent master. That pairs with `--no-music-bed`: cut every shot to
the resolved tempo/drop, then add the actual Apple Music track back inside
TikTok/Reels, where the DRM restriction doesn't apply.

## Reuses the VZT stack

- Transcription leans on the pure-WASM Whisper backend in
  [`vzt-video-intel`](https://www.npmjs.com/package/vzt-video-intel).
- Moment selection uses the `claude` **or** `codex` CLI subscription (same
  zero-API-cost pattern as `tele-build-agent`), behind the `src/llm.js` adapter.
