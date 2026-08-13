# Where to get music and SFX

Nothing copyrighted ships with this repo. You point the tool at your own
library. This is where to build one, and — more importantly — which route to
take for which destination.

---

## First: the licensing thing that trips everyone up

**You cannot download TikTok's or Instagram's in-app music and burn it into an
exported MP4.** Those libraries are licensed for use *inside those apps*. The
moment the track is baked into a file you distribute, you are outside that
licence. It is also the single most common way a good reel gets muted, blocked,
or stripped of audio.

There are two legitimate routes, and they lead to different outputs:

| Destination | Route | Flag |
|---|---|---|
| TikTok / Reels / Shorts | Cut to the track, export **silent**, add the official sound in-app | `--no-music-bed` |
| YouTube, Hudl, recruiting email, website, anything you host | Burn in a **licensed / royalty-free** track | *(default)* |

### The in-app route (best for reach)

Native audio gets better distribution — the platform pushes content using
trending sounds. So this is usually what you want for social:

1. Get a copy of the track locally (a purchase, a rip of your own file, or the
   platform's own download where offered).
2. Cut to it: `reelclip game.mp4 --mode hype --music track.mp3 --no-music-bed …`
   The track still drives every cut — beat grid, hook on the drop, ramps on the
   beat — it just isn't mixed into the output. You get an SFX-and-ambience
   master.
3. Upload, then select **the same official sound** in-app and mute your video's
   audio.

Because it is the same recording, the cuts line up. This is the workflow to
default to for social.

### The burn-in route

For anywhere you host the file yourself, use music you are licensed to
distribute. Sources below.

---

## Free music (downloadable, distributable)

| Source | Licence | Notes |
|---|---|---|
| **YouTube Audio Library** (`studio.youtube.com` → Audio Library) | free, mostly no attribution | The best free starting point. Filterable by mood/genre; also has a sound-effects section. |
| **Pixabay Music** | free, no attribution required | Large, genuinely no-strings. Decent trap/hip-hop for sports edits. |
| **Uppbeat** | free tier with attribution | Curated, sports/hype-friendly. Free tier has monthly download limits. |
| **Free Music Archive** | Creative Commons (varies) | Check each track's licence — some are non-commercial only. |
| **Incompetech** (Kevin MacLeod) | CC-BY | Attribution required. Huge catalogue. |
| **ccMixter** | Creative Commons | Remix-friendly. |

## Paid (worth it if you post regularly)

| Source | Notes |
|---|---|
| **Artlist** | Flat annual fee, unlimited downloads, covers social + monetised. Popular with sports editors. |
| **Epidemic Sound** | Similar model, very large catalogue, strong sports/hype sections. |
| **Soundstripe**, **Musicbed** | Same idea; Musicbed skews cinematic. |

## Free SFX (whoosh / impact / riser)

This is where the sound-design pillar lives, and the free options are excellent:

| Source | Notes |
|---|---|
| **Sonniss GDC Game Audio Bundle** | The best-kept secret. Many GB of professional, royalty-free SFX released free every year. Impacts, whooshes, risers, crowd. Start here. |
| **Pixabay SFX** | Free, no attribution. Quick and easy. |
| **Freesound.org** | Creative Commons; check per-file licence. Huge. |
| **YouTube Audio Library** | Has a sound-effects tab, free and clear. |

---

## Library layout

The tool expects your SFX organised by category. Anything not present is simply
skipped, so you can start with three files and grow:

```
~/vzt-audio/
  music/
    track-128bpm.mp3
  sfx/
    whoosh/   whoosh-01.wav  whoosh-02.wav …
    impact/   impact-01.wav  hit-heavy.wav …
    riser/    riser-01.wav …
```

Create it with:

```bash
mkdir -p ~/vzt-audio/music ~/vzt-audio/sfx/{whoosh,impact,riser}
```

Then:

```bash
reelclip game.mp4 --mode hype --sport 7v7 \
  --music ~/vzt-audio/music/track-128bpm.mp3 \
  --sfx-dir ~/vzt-audio/sfx
```

Cues rotate deterministically through the files in each category, so three
whooshes beats one whoosh used nine times.

---

## Picking a track for a sports edit

- **120–150 BPM** cuts well for highlights. Slower drags; faster gives shots too
  little room to read.
- **A clear drop matters.** The hook is placed on it. Run a track through and
  check the log — "no clear drop" means the hook falls back to ~2 bars in.
- **Intro length**: 5–10s before the drop is ideal, matching the B-roll runway.
- Instrumentals or light vocals. A busy vocal fights burned-in captions.
