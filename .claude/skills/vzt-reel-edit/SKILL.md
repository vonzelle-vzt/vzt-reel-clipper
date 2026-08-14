---
name: vzt-reel-edit
description: The sports-edit doctrine — how to cut game film into a hype reel that actually performs. Use whenever editing, planning, or reviewing a sports video, highlight reel, or vertical short, or when changing how vzt-reel-clipper selects, orders, paces, or renders shots. Applies to every sport.
---

# Editing doctrine

## First: which of the two products is this?

"Sports edit" is **two genres with different grammars**, and treating one like
the other is why an edit feels wrong. Decide this before anything else.

| | **Hype reel** | **Cinematic recap** |
|---|---|---|
| Length | 20–60s | 3–20 min |
| Driven by | the music | the story |
| Audio lead | track + SFX | **commentary + natural audio** |
| Cut logic | **on the beat** | **on the action** |
| Ends on | the climax | **a wide shot** |

`--mode hype` builds the first. The recap is a separate discipline — its rules
are in the second half of this file and in `docs/SPORTS-EDIT-DOCTRINE.md`.

Four things separate a boring hype reel from one that gives people chills:
**music, pacing, sound design, and creative decisions.** Everything below is
downstream of those four. This applies to every sport — the vocabulary changes,
the doctrine does not.

When cutting anything in this repo, follow this. When changing code that
selects, orders, paces, or renders shots, the change has to serve one of these.

---

## 1. Edit to the music — don't edit *on top of* it

The track is not a backing layer, it is the timeline. Every cut, effect, and
sound is motivated by it.

- **Cuts land on beats.** Not "roughly on the beat" — allocate shots in whole
  beats off a real beat grid so alignment is true by construction.
- **The best play lands on the drop**, typically 5–6s in.
- Shot lengths are whole musical bars, so the edit breathes with the track.
- Effects follow the energy; sound design elevates the music instead of
  fighting it.

In code: `src/music.js` produces `{bpm, beats[], downbeats[], drop}`, and
`src/plan.js` allocates shots in beat counts. If you find yourself computing a
duration in seconds and snapping afterwards, you have already lost the grid.

## 2. Pacing is a rollercoaster, not a metronome

Uniform shot lengths are the single most common reason an edit feels flat.

> Build energy → deliberately slow down → rebuild to a climax.

Tension is easy to build and hard to keep; the *release* in the middle is what
makes the second build hit. Slow moments create tension, fast cuts create
excitement, and switching between them is what holds attention.

In code: `ARCS.rollercoaster` in `src/plan.js`. Note it is driven by progress
through the **material**, not through the song — otherwise a short reel silently
never reaches its climax.

**Anti-pattern:** a fixed pre-roll/post-roll around every play. That produces
identical-length clips and is exactly what this tool used to do.

## 3. Hook first — never save the best clip for last

Put the strongest play on the drop. Do **not** order plays chronologically.
Most viewers are scrolling; the first second is effectively the thumbnail, and
90% never reach the end.

Structure:

| Section | Length | Content |
|---|---|---|
| Intro | 5–10s | B-roll: warm-ups, huddle, emotion, crowd |
| **Hook** | on the drop | the single best play |
| Body | most of it | alternate action ↔ B-roll, alternate angle |
| Outro | short | celebration, handshake line, coach, walk-off |

Alternate B-roll with highlights. Nobody wants a straight highlight tape — the
emotion clips are what turn a recap into a story. And alternate angles: never
two adjacent shots from the same framing.

## 4. Sound design is what makes it feel alive

Sound is texture; without it the edit is flat no matter how good the footage.

- **Lay sound before picture.** With a music-led edit, drop the track first and
  design a whoosh/impact/riser pattern against it *before* any clips exist. Then
  cut the picture onto that foundation.
- Then layer enhancers once picture is in: crowd, ball bounces, shoe squeaks,
  contact.
- **Mix it.** Not too loud, not buried. Normalize the final to about **−14 LUFS**
  so it sits right in a feed.

In code: `src/sfx.js` resolves cues from the user's own library
(`whoosh/`, `impact/`, `riser/`), and `src/composite.js` mixes and normalizes.
Never commit copyrighted audio to the repo.

## 5. Speed ramping beats slow motion

Don't slow an entire clip. Ramp *into* the moment of impact and speed back out —
it accentuates the exact frame that matters. Anchor the ramp on the detected
peak of the play.

In code: `solveRamp()` in `src/plan.js`. It sizes the slow window as a fraction
of the shot, because a fixed-length slow window doesn't fit short shots and the
ramp then silently never applies.

## 6. Transitions: earn them

Natural **whip pans** and **match cuts** only. Whip: cut from a camera moving
right-to-left into another moving right-to-left. Match cut: cut between two
similar actions (crossover to crossover, shot to shot) — this also lets you
stitch a great move that ended in a miss onto a different finish.

Preset packs — glitch, star wipes, "cinematic transitions vol. 3" — read as
tacky and amateur. A hard cut on the beat is almost always stronger.

In code: `motionDirection` (`src/score.js`) measures each play's travel, and
`plan.js` joins two consecutive action shots with a whip only when both move and
move the *same way*. Everything else is a hard cut. A locked-off tripod
produces no whips at all — that is correct, not a bug: there is no camera move
to match. True match cuts (adjoining similar actions) are **not** implemented;
choosing them is still a human call.

## 6b. Framing wide footage

A centre crop to 9:16 throws away a third of a wide field on each side. Use
`--fit smart`, which plans a camera path per shot.

Pick the detector to match the subject:

| Footage | Backend | Why |
|---|---|---|
| Team sports, wide | `motion` (default) | follows the busiest band of the frame — the ball-side cluster |
| Talking head, interview | `onnx` | person detection is genuinely the subject (needs `onnxruntime-node` + a YOLOv8 model) |

Person detection on a wide team-sport shot finds fourteen people spread across
the field, concludes it can't frame them all, and letterboxes — working exactly
as designed while achieving nothing.

## 7. Grade subtly

Most edits are graded either far too hard or not at all. Aim for realistic with
a little pop. `src/grade.js` has `punch`, `teal-orange`, `film`; a custom
`.cube` LUT can be passed with `--lut`.

## 8. Captions

Bold, condensed, uppercase, high contrast, one short phrase at a time. Keep them
clear of the platform UI — roughly the bottom 15% and the right rail are covered
by TikTok/Reels chrome.

---

## Sport-agnostic by construction

Never hardcode one sport's language. `src/profiles.js` holds, per sport: CLIP
search vocabulary for highlights / B-roll / outro, the play window
(`preroll`/`postroll`/`minGap`), stoppage vocabulary, and whether play is
continuous (basketball, soccer, hockey, lacrosse, volleyball) or resets every
play (football, baseball, track, wrestling, tennis). Continuous sports take
tighter windows; reset sports need a longer pre-roll to catch the setup.

Adding a sport means adding a profile entry — nothing else.

## Selection: never trust audio alone

Audio-energy peak detection fails on the footage this tool actually gets.
Parent- and coach-shot phone film has no crowd mic, so every moment scores
neutral and there are no peaks to find. Worse, when there *is* crowd audio, the
loudest moments are often *dead* — the whistle, and the crowd still roaring
while everyone stands around.

Score on motion (0.30) + **burst** (0.25) + audio (0.20) + context (0.25, CLIP hits for that
sport). Reject **loud-but-still** as dead ball. Do *not* reject quiet-and-still
on audio grounds — on silent phone film that is where the action lives.

**Burst** is the half-wave-rectified derivative of the motion curve — where
something *starts* happening. Magnitude alone cannot tell a play from a crowd
milling about, because both are "some pixels changed"; what separates them is
the onset. A play begins with a near-simultaneous acceleration and then
sustains, while standing around is flat.

Three traps worth knowing, all found on real footage:

- **A silent track is not a missing track.** A file can carry an audio stream
  with no sound in it; normalizing that flat line yields a constant 0.5 that
  looks like data and dilutes every score. Drop it instead, so its weight goes
  to motion and context.
- **Measure motion in the field band, not the whole frame.** A substitute
  standing two metres from the lens moves far more pixels than a receiver
  fifty yards downfield, so whole-frame motion tracks the sideline and ranks
  players standing with their hands on their hips as the biggest play in the
  video. Restricting to the middle band puts the field back in charge.
- **Dead-ball rejection needs audio.** On fully silent film there is no
  loud-but-still tell, so nothing is rejected and sideline milling can be
  selected. Expect to raise `--sensitivity` on such footage, and say so rather
  than implying the selection was smarter than it was.

---

# The cinematic recap — a different grammar

Longer, story-led, and **audio-first**. The test a working editor applies:

> A listener should follow the whole story from the audio alone, without
> watching the picture.

## Audio carries it

- Separate lanes for music, **commentary**, natural/camera audio, and SFX.
- **Two reverb buses** — one moderate, one extreme. Their job is to let a word
  ring when you cut into silence, usually the commentator's last word before a
  key moment.
- Duck with a **parametric EQ dipping the music's mids**, not by pulling the
  fader. Dialogue cuts through and the music never audibly moves.

## Cut on the action, not the beat

This is the recap's equivalent of beat-syncing:

- Cut **mid-movement** — the instant the runner is occluded, plants a foot, or
  starts to fall. Never after the motion settles.
- **Show an important action twice**, from two angles, to place emphasis on it.
- Then run the reaction chain: *action → the player who did it → the player it
  happened to → bench → crowd → score graphic.*
- Let the ball hang in flight. Hold, pause, then pay it off.

## Structure

1. **Intro, 30–40s:** scene, arrivals, warm-ups, teams out, trophy, pregame.
   Then straight into action — do not linger on pregame.
2. **Establish the event within two seconds.** One editor match-cut the same
   logo filmed all over the stadium, aligned with guides so the cuts are
   seamless.
3. **Body:** action–reaction chains, with score/time graphics — without them a
   viewer loses track of the game state.
4. **Climax:** set the stakes (an injury, a sack), then **cut to silence for a
   long beat** before the decisive play. The silence *is* the tension.
5. **Post-game:** emotional interview audio laid *under* the visuals — the
   underdog line, the disbelief, the crying. This is where it lands.
6. **End WIDE** (confetti, stadium), then fade to logo. Never end tight; a close
   shot gives the viewer nothing to close on.

## Plan before cutting

Watch the footage first and write every big play with its timestamp, in order.
Tick each as it goes in; cross out anything deliberately skipped. That is what
makes the edit tell the *true* story — every score, not just the pretty moments.
`reelclip watch` produces exactly this list.

---

## Checklist before calling a reel done

- [ ] Every cut lands on a beat
- [ ] Best play is on the drop, not last
- [ ] Shot lengths vary, with a visible slow-down and rebuild
- [ ] Action and B-roll alternate; no two adjacent shots share an angle
- [ ] Ramps land on the actual moment of impact
- [ ] Sound: whooshes on transitions, impact on the drop, riser into it
- [ ] Loudness ≈ −14 LUFS
- [ ] Grade is subtle
- [ ] It ends deliberately, not abruptly
- [ ] Cover frame is the strongest single image
