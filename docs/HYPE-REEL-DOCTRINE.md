# The hype reel, as NextPlay built it

Ported from the NextPlay `T38 — Hype Reel` task and its
`HIGHLIGHT-CREATION-GUIDE.md`. Everything with a number attached was measured
there on production data, not asserted — that is the reason to copy it rather
than re-derive it.

Source: `~/github-projects/nextplay`, `src/lib/highlights/`, shipped at v7.11.

---

## 1. Three forms get confused, and they are not the same edit

| Form | Length | Grammar |
|---|---|---|
| Highlight / recruiting tape | 3–5 min | complete, chronological, coach-facing, **no music** (coaches mute) |
| Cinematic recap | 2–5 min | slow, reverent, letterboxed, music and narration led |
| **Hype reel** | **20–40s** | **escalating, front-loaded, cut on impact, built to stop a thumb** |

**A hype reel is the only form that CHOOSES.** Every other mode renders the whole
reel; hype takes the best handful. That is the form, not an optimisation — the
hype look applied to all 211 clips of a season is a 20-minute video, which is not
a hype reel by any definition.

## 2. Platform numbers

| Platform | Length | Clips | Each | Music |
|---|---|---|---|---|
| TikTok / Reels | 15–30s | 4–6 | 3–5s | required, beat-synced |
| YouTube Shorts | 30–60s | 6–10 | 4–6s | required |
| YouTube highlight | 3–5 min | 15–20 | 8–15s | background, low |
| Recruiting tape | 3–5 min | 15–20 | 15–20s | **none** |

**Target ~32s, 4–6 clips** — the overlap where one file works everywhere. 32
rather than 30 so a clip landing at 31.5s is included instead of leaving the cut
at 24s: overshoot is cheaper on this form than ending before it built to
anything.

### One reel, two deliverables

NextPlay ships the same analysed reel as two rendered artifacts, and treats the
pair as a hard rule rather than a preference:

| Format | Spec |
|---|---|
| **Highlight** | 9:16 vertical · for social |
| **Recruiting** | 16:9 landscape · **muted end to end** — the file you send a coach |

The mute is enforced in three places (the stitcher, the share-link player, the
mobile app) because a coach opening a file with a music bed on it closes it. The
aspect is not a taste call either: a portrait reel on a recruiting page "would be
a product lie."

→ This is why `--aspect 16:9` matters here. Wide-field sports footage on a 9:16
canvas keeps roughly a third of its frame width, and the action is exactly what
gets cropped out.

## 3. The rule that matters most

> **QUALITY OUTRANKS SCORE.**

A score measures how *interesting* a window is. It does not answer whether
anything happened, and on real footage those come apart. Measured on one real
11-clip reel, ranked by composite score:

| score | the model's own words | reality | made the cut? |
|---|---|---|---|
| 0.46 | "Player **drives toward basket**… defensive pressure" | a play | ✅ |
| 0.42 | "…**rather than competitive game action**" | not a play | ✅ |
| 0.41 | "game **in progress**… players **spread across court**" | not a play | ✅ |
| 0.3325 | "Player **attempting offensive action** against defenders" | a play | ❌ |

Two non-plays outranked a real one. The 0.41 clip's source frames, pulled end to
end, were **players standing around a field of hurdles for its entire length** —
its "live play" and its "peak action at 3.5s" were both fabricated, which is why
no within-clip tuning could have rescued it.

The report that produced the rule: *"at 13 seconds it shows dead space, no
action."* This repo received the same report on the same kind of footage.

**Sort by tier first; use the number only to order within a tier.**
→ implemented in `src/quality.js`, wired at `src/plan.js`.

## 4. The other selection rules, each from a real failure

| Rule | The failure it prevents |
|---|---|
| **Fewer clips, never shorter ones** | Four separate attempts to cap middle clips were each reverted for cutting real plays mid-action. Hit the runtime by choosing fewer plays. |
| **Never show the same take twice** | Two adjacent camera-roll files from a tripod were both genuine, both high-scoring, and the reel visibly repeated itself. Reported as *"it played the same clip 2x."* |
| **A short reel beats a padded one** | Once the floor is met, never reach into a lower tier for runtime. Better a genuine 20s cut of three real plays than a 32s one with two duds. |
| **Never pad with a no-action clip** | A hard stop, not a penalty. |
| **The pinned hero play is always in** | Whatever it scored. |
| **Selection is pure and deterministic** | Preview and render call it independently and must agree exactly, or the file you download is not the cut you approved. |

## 5. Sequencing: open on the BEST play

Open on the best, close on the second best, bury the weakest in the middle.

This is where hype departs from a narrative highlight, which opens on the
second-best and saves the best for a climax. **That arc assumes the viewer is
already watching.** A hype reel has to earn the second it takes someone to
decide, so the hook comes first.

> Rule of 3: a viewer engages in 3 seconds, decides in 5, scrolls in 7.

**Where this repo differs, deliberately.** NextPlay's hype reel is *silent*, so
t=0 is the only hook position available. This tool is music-driven and puts its
hook on the drop. Both are right; the synthesis is to do both — **open on the
best play at t=0 and land the second-best on the drop** — rather than leave the
first seven seconds to setup.

## 6. Pacing and look

- Average shot **2–5s** for social; **15–25 cuts per minute** for high energy.
- Build pattern: medium → high → **PEAK** → brief pause → repeat.
- After a big play, hold **1–2 extra seconds**.
- **80% hard cuts.** Whip pan for urgency, match cut on movement direction,
  crossfade sparingly. Never a default wipe.
- Slow-motion on the **top ~15% of plays only**. 0.5× for general action, 0.25×
  reserved for THE moment. Slow only the peak, never the whole clip.
- Text early, because most people watch on mute.
- Grade: orange & teal, high contrast, at **60–80% opacity** — never full.
  Fix exposure and white balance *first*.

### The ramp, and why the resolve runs FAST

```
approach 1.30×  →  impact 0.35×  →  resolve 1.60×
window −0.35s / +0.65s around the peak
```

The first draft used the cinematic window (−0.6/+1.0) at a 1.0× resolve. On a
real 6.88s average clip that produced **9.56s per clip**, so a 30-second reel was
**3.1 clips** — below the 4–6 the form needs. Real clips carry a ~4s tail of
celebration and jogging back; running the resolve at 1.60× brings the clip to
6.78s and the reel to ~4.4 clips.

> **Hype accelerates the boring parts.** That is the whole difference from a
> cinematic edit, which slows everything.

This repo currently only ever *slows* (ramps at 0.6–0.8×) and cuts dead time out
entirely. Speeding through the tail is unimplemented.

## 7. Measured costs, worth not re-learning

Benchmarks on `ffmpeg-static`, 10s of 1080p, `-preset veryfast`:

| Chain | Cost | vs baseline |
|---|---|---|
| plain render | 0.53s | 1.0× |
| cinematic grade | 1.55s | 2.9× |
| **hype grade** (per-channel `curves` + `eq`) | **1.02s** | **1.9×** |
| anything with `colorbalance` | 4.22s | **8.0×** |

1. `colorbalance` is the most expensive filter tested. Per-channel `curves` costs
   the same as luma-only, so **teal-orange rides inside the curve for free**.
2. `eq` is effectively free (0.54s vs a 0.53s baseline).
3. `crop` has **no timeline support** — `enable='between(t,a,b)'` fails the graph
   outright. A shake window must live inside the crop *expression*.
4. Blurring a downscaled copy costs 1.8× vs 4.5× at full res and looks identical.

## 8. Two defects only *looking* could have caught

- A variable font rendered as hairline Thin. `drawtext` does not select a named
  instance from a variable font — it takes the default, which for that family was
  the lightest weight. **A perfectly valid MP4 with unreadable type and no error
  anywhere.** Fixed by using a single-weight font.
- A 9:16 frame that was half black bars. `contain` is correct (`cover` crops the
  athlete's head) but a landscape source in a vertical frame reads as a broken
  export.

Both are the same lesson this repo relearned with contact sheets: the checks
prove a render is *correct*; only looking proves it is *good*.

---

## Port status

| Piece | Here |
|---|---|
| Quality tier over score | ✅ `src/quality.js`, wired at `src/plan.js` |
| Classify from **frame labels** (not prose) | ✅ — the answer NextPlay named but could not take, because its browser preview cannot fetch video and ours stands next to the file |
| Never the same moment twice | ✅ `sameMoment` in `pickHypeClips`; **not yet applied to outro selection in `plan.js`** |
| Short beats padded / no-action never pads | ✅ |
| Target 32s, 3–8 clips, fewer-not-shorter | ⚠️ module has it; `planEdit` still fills a beat grid |
| Open on the best play at t=0 | ❌ hook is still at the drop only |
| Fast resolve (1.60×) — accelerate the tail | ❌ ramps only slow |
| Slow-mo capped at the top 15% | ❌ ~33% of shots ramp |
| White flash / punch / shake on the cut | ❌ CapCut's territory |
