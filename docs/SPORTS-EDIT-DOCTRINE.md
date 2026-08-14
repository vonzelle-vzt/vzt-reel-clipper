# Sports edit doctrine — two genres, two grammars

Distilled from working sports editors breaking down real client deliveries. The
important discovery is that **"sports edit" is two different products** with
different rules, and conflating them is why edits feel wrong:

| | **Hype reel** | **Cinematic recap** |
|---|---|---|
| Length | 20–60s | 3–20 min |
| Driven by | the music | the story |
| Audio lead | track + SFX | **commentary + natural audio** |
| Cut logic | on the beat | **on the action** |
| Structure | hook → arc → climax | scene → stakes → action → climax → emotion |
| Ends on | the climax | **a wide shot** |

This tool currently builds the **hype reel**. The recap is a second mode, and
most of what follows is not yet implemented — the gaps are marked.

---

## Genre 1 — The hype reel

### Sound design (the part editors lead with)

Sound is treated as the first layer, not a garnish. In one breakdown the editor
built the entire SFX pass *before* discussing a single visual effect.

- **Crowd ambience under everything.** Described as barely noticeable alone but
  making "a huge difference" to the whole. Cheapest large win available.
  → *implemented: an `ambience/` bed, laid under the reel and mixed well down.*
- **A riser into the drop.** Coming out of ultra slow-motion into the song's
  drop, the riser is what makes the drop land, resolving into an impact.
- **Layered hits, one per event.** Not a pattern applied uniformly — a hit per
  hyperlapse, per flash cut, per block.
- **HIT-TO-SLOW.** The most transferable note in either breakdown: when the
  picture goes fast and then slows, an impact **with a long tail** lands *at the
  moment it slows*. Without it "it feels so empty"; with it, "a world of a
  difference."
  → *implemented: an impact cue at the ramp point, requesting `impact-tail/`
  and falling back to `impact/`.*
- **Deep whooshes on whip pans** and on wipes between shots.
- **Layer with the in-game audio** rather than replacing it.
- **Do not double up on the music.** One impact was deliberately omitted because
  the track's own hit already landed there.
  → *implemented: cues within 70ms of a downbeat are suppressed.*

SFX libraries named by working editors: Ocular Sounds (Aperture, Quantum,
Shift, Forge, Utility Designed), Sounds from the Den 1 & 2, Artlist. See
`AUDIO-SOURCES.md` for free alternatives.

### Visual effects

- **Speed ramps everywhere**, with the movements flowing between them.
- **Hyperlapse** — track a point, speed up hard (4,000–13,000%), stabilise, ramp
  the ends, and add **motion blur**. Without motion blur the result "looks
  yucky"; keep it subtle or it warps. *(gap: we never speed footage up)*
- **Ultra slow-motion** — 1% speed with optical-flow interpolation. Wants 120fps
  source; 60 is workable, 24 is pushing it. *(gap: our ramps stop at ~0.5x)*
- **Flash cuts** and flicker between shots. *(gap)*
- **Fisheye whip pans** — only reads if the lens is *very close* to the subject;
  shot wide, the movement disappears.
- **Chromatic aberration** on the ultra-slow hero moment. *(gap)*
- **Black and white + grain**, grain overlaid on hard light. *(gap)*

---

## Genre 2 — The cinematic recap *(not yet built)*

### Audio carries the story

> A listener should be able to follow the whole story from the audio alone,
> without watching the picture.

Track layout from a real 99-minute delivery: two music, two commentary, three
for SFX and camera audio, and **two reverb buses** — one moderate, one extreme.
The reverb is used to let a word ring when cutting into silence, typically the
commentator's last word before a key moment.

Ducking is done with a **parametric EQ dipping the mids of the music**, not by
pulling the fader. Dialogue then cuts through without the music audibly moving.
*(gap: we duck by level and sidechain, not by frequency)*

### Action–reaction is the grammar

The recap's equivalent of "cut on the beat" is **cut on the action**:

- Cut the instant the subject is occluded, plants a foot, or begins to fall —
  always mid-movement, never after it settles.
- **Show an important action twice.** A key throw was shown from two angles to
  place emphasis on it.
- Then run the reaction chain: *action → thrower → receiver → bench → crowd →
  score graphic*.
- Hold on the ball in flight, let it pause, then pay it off.

*(gap: we alternate action and B-roll but do not seek reactions after a play,
and never repeat a hero moment)*

### Structure

1. **Intro, 30–40s:** scene-setting drone, arrivals, warm-ups, both teams out,
   trophy, pregame, flyover — then straight into action. Do not linger.
2. **Establish the event fast.** One editor filmed the same logo all over the
   stadium, aligned each with guides, and match-cut them so the viewer knows
   what event this is within two seconds.
3. **Body:** action–reaction chains, with score/time graphics for orientation —
   without a score bug, viewers lose track of the game state.
4. **Climax:** set the stakes (an injury, a sack), then **cut to silence for a
   long beat** before the decisive play. The silence is the tension.
5. **Post-game:** emotional interview audio laid *under* the visuals — the
   underdog line, the crying, the disbelief. This is where the story lands.
6. **End on a WIDE shot** (confetti, the stadium), then fade to logo. Never end
   tight — a close shot gives the viewer no context to close on.

### Planning method worth copying

Watch the highlight pack **before** editing. Write every big play with its
timestamp, in order. Tick each one as it goes in; cross out any deliberately
skipped. This guarantees the edit tells the *true* story — every score, not just
the visually appealing moments.

*(This is essentially what `reelclip watch` produces automatically.)*

---

# The match cut — the transition that outranks every effect

A working editor's blunt version: presets and overlays are crutches. **The match
cut is the most important technique in the bag**, because it is so organic that
nobody asks why there wasn't an effect — and when you *do* add an effect on top,
it lands better, because the cut already made sense underneath it.

Three kinds, in order of power:

### 1. Match the MOVEMENT *(the one that matters most)*

Sequence shots whose action travels the **same direction**. Left-to-right into
left-to-right into left-to-right. The eye tracks continuously and never gets
yanked to the other side of the frame, so the cut disappears.

This applies to both the movement *inside* the frame and the **camera's own
pan direction** — panning left-to-right across a left-to-right action doubles
the continuity.

Deviate deliberately, not accidentally. You cannot have every clip moving one
way; change direction at a moment you *choose*.

→ *We already compute `motionDir` per play. It was only being used to decide
whether to whip. It should also decide the ORDER.*

### 2. Match the ACTION — fake a second camera

Cut between two separate takes of the *same action* at the frame where the
body position matches. One editor filmed a player shooting from the front and
from 45°, cut on the frame where the hand sits under the ball, and viewers
insist there were two cameras. There was one.

Sequence: angle A lining up → **cut on matching hand position** → angle B
through the release and the make → angle A for the reaction.

Works for any repeated sport action: a shot, a dribble move, a spike, a slap
shot, a throw.

### 3. Match the COMPOSITION

Keep the shot *scale* consistent through a sequence — all medium, all waist-up,
subject in a similar part of the frame. Cutting wide → tight is jarring; the
viewer notices the edit instead of the content.

Vary the composition **across** sequences, not within one.

---

# In-camera transitions, and the loop

- **Cut on motion blur.** End a clip on a whip and start the next on a whip
  **in the same direction**. Mismatched directions break it — one editor caught
  himself ending right-to-left and starting left-to-right and re-cut it.
- **Speed-ramp the whip faster** so the viewer has no time to register the
  change: "things happen really quickly and the audience doesn't have time to
  react to the fact that you're switching clips."
- **Slow-mo the ball in the air**, ramp back to 100% for the result.
- **Speed up dead time** rather than cutting it — holding on a made basket for
  a few seconds is unsatisfying; ramp through it. *(gap: we cut it out entirely)*
- **Make it LOOP.** For a feed reel, the last movement should flow into the
  first. Worth checking deliberately. *(gap)*

### Overlays, used with restraint

- One subtle light-leak/grain overlay across the **entire** video at ~**8%
  opacity**, blend mode **linear dodge (add)** — used on every single edit.
- Overlays to *distract* during an unsatisfying beat (the ball already in, the
  frame just sitting there).
- Overlays on moments of **emphasis** — a burn over the ball hanging in slow
  motion.
- **Flash transitions**: find the white frame in the overlay and park it exactly
  on the cut. *(gap: all of this is CapCut's home turf)*

---

## Implemented vs gaps, at a glance

| Technique | Status |
|---|---|
| Beat-synced cuts, hook on the drop, pacing arc | ✅ |
| Speed ramps anchored on impact | ✅ |
| Hit-to-slow impact with tail | ✅ |
| Crowd ambience bed | ✅ |
| Suppress SFX that collide with the music | ✅ |
| Riser into the drop | ✅ |
| Whooshes on transitions, whip pans | ✅ |
| Motion blur on fast sections | ❌ |
| Hyperlapse / speed-up | ❌ |
| Ultra slow-motion (1% + optical flow) | ❌ |
| Flash cuts, flicker, chromatic aberration, grain | ❌ |
| Action–reaction chains | ❌ |
| Repeat the hero action | ❌ |
| Cut to silence before the climax | ❌ |
| End on a wide shot | ❌ |
| Score/time graphics | ❌ |
| Frequency-selective ducking | ❌ |

The unticked rows are the roadmap, roughly in value order. Several — flash cuts,
grain, chromatic aberration, motion blur — are exactly what CapCut's effect
library provides, which is the strongest argument for the CapCut export path.
