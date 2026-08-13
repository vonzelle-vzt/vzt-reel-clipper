---
name: vzt-reel-ingest
description: "Here's my film, cut it" — the workflow for taking submitted game footage (one file, a folder, or multiple angles) and turning it into a finished hype reel. Use whenever the user hands over video to edit, points at a footage folder, or asks for a reel from their game. Applies to every sport.
---

# Ingest: from raw film to a finished reel

This is the workflow when someone hands over footage. Follow it in order. The
craft rules live in `vzt-reel-edit`; this is the operational path.

---

## Step 0 — Ask only what you can't detect

You need three things. Two are usually inferable, one is not.

1. **Sport** — required, and usually obvious from the footage. If ambiguous, ask.
   Valid: basketball, football, flag-football, soccer, lacrosse, baseball,
   softball, volleyball, hockey, wrestling, track, tennis, generic.
2. **Music** — *required and cannot be inferred.* The track drives the entire
   edit. Ask for a file if none was given. Never substitute one silently, and
   never download copyrighted audio.
3. **SFX library** (optional) — a folder with `whoosh/`, `impact/`, `riser/`
   subfolders. Without it the reel still renders, just without sound design.

Also worth asking, but only if it matters: target length, and whether a
specific player should be featured.

## Step 1 — Inventory the footage

```bash
ls -la <dir>
ffprobe -v error -show_entries format=duration,size \
        -show_entries stream=width,height,r_frame_rate,codec_type \
        -of default=nw=1 <file>
```

Record for each file: duration, resolution, fps, and whether it has an audio
stream. Expect no usable audio — that is normal, not a problem.

**Multiple files / angles:** build a cross-video index once, then the whole
corpus is searchable:

```bash
vintel index <dir>
```

## Step 2 — Understand what's in it

`vintel` runs offline and free in lite mode. Confirm with `vintel auto`.

```bash
vintel scenes <file>                       # shot boundaries
vintel search <file> "player dunking"      # CLIP semantic search
vintel observe <file>                      # fused timeline, if you need detail
```

Use this to sanity-check that the action is where you think it is *before*
rendering anything. If CLIP returns nothing useful, the pipeline falls back to
motion + audio scoring — say so rather than pretending it used semantics.

## Step 3 — Cut it

```bash
reelclip <file> --mode hype \
  --sport <sport> \
  --music <track.mp3> \
  --sfx-dir <sfx-dir> \
  --out <outdir>
```

Useful adjustments:

| Symptom | Flag |
|---|---|
| Too few plays chosen | `--sensitivity 0.5` |
| Junk plays / standing around chosen | `--sensitivity 1.5` |
| Action too small in frame (wide film) | `--fit smart` |
| Reel too long | `--duration 30` |
| Ramps feel gimmicky | `--no-ramps` |
| Grade too strong | `--grade none` or `--lut mine.cube` |
| Want relentless pacing | `--arc build` |

`--sensitivity` scales a **relative** floor against the best play in *this*
video, not an absolute threshold. `1.0` keeps anything scoring above ~35% of the
top play; higher is stricter. It is relative because an absolute cutoff computed
from the score distribution can land above the highest score in the file and
select nothing at all.

**Wide footage**: add `--fit smart`. The default `motion` backend follows the
busiest part of the frame and needs no model. Use `--reframe-backend onnx` only
for talking-head footage.

Outputs: `00-hype-reel.mp4`, `cover.jpg`, `edl.json`.

## Step 4 — Review the EDL before trusting the render

`edl.json` is the edit as data, and it's much faster to check than to watch.
Verify:

- The hook shot has `"hook": true` and sits at the music's drop
- Shot durations **vary** (a uniform list means the arc didn't apply)
- `kind` alternates between `action` and `broll`
- Action shots have a `ramp`
- No two adjacent shots share an `angle`

## Step 5 — Verify the render

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 out/00-hype-reel.mp4   # 1080,1920
ffprobe -v error -show_entries format=duration -of csv=p=0 out/00-hype-reel.mp4                            # ≈ edl.duration
ffmpeg -i out/00-hype-reel.mp4 -af loudnorm=I=-14:print_format=summary -f null -                           # ≈ -14 LUFS
ffmpeg -i out/00-hype-reel.mp4 -vf blackdetect=d=0.5 -f null -                                             # no long black
```

Then **watch it.** The checks prove it is correct; only watching proves it is
good. Check specifically that cuts feel on-beat and the hook lands.

## Step 6 — Report honestly

Tell the user:

- How many plays were found, and how many were rejected as dead ball
- Whether CLIP semantics were used or it fell back to motion+audio
- Whether a drop was detected (if not, the hook was placed ~2 bars in)
- Any SFX cues skipped for a missing sample
- Reel duration vs the music length — the reel ends when the material ends,
  which is intentional, not a bug

---

## Failure modes and what they mean

| What you see | Cause | Fix |
|---|---|---|
| `no plays found` | nothing stands out from the footage | `--sensitivity 0.5`; confirm the file has action |
| `audio track unusable` | silent stream, or nothing above -70 LUFS | expected on phone/tripod film; scoring drops to motion + context |
| `play spacing relaxed 20s → 4s` | short or already-edited source | expected; the profile gap assumes raw game film |
| shots show players standing around | silent film, so no dead-ball tell | raise `--sensitivity`; dead-ball rejection needs audio |
| no whip transitions | locked-off camera, nothing travels | correct — a whip matches camera movement that isn't there |
| `music track too short to estimate a tempo` | clip shorter than a few seconds | use a full track |
| `no clear drop` | track has no strong bass entry | fine — hook goes ~2 bars in |
| every shot the same length | arc didn't apply | check `edl.json`; likely too few shots |
| reel much shorter than the song | ran out of footage | expected; add material or shorten the track |
| sfx cues skipped | category folder missing/empty | check `whoosh/ impact/ riser/` layout |

## Rules

- **Never** commit or download copyrighted music or SFX. The user's library
  stays on their disk and is passed by path.
- **Never** silently substitute a music track.
- Don't claim semantic selection when it fell back to motion+audio.
- If footage is genuinely unusable (no action, unreadable), say so plainly
  rather than shipping a reel built from noise.
