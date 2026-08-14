# CapCut Automation Research

Date: 2026-08-13

## Executive Recommendation

Use a **Node-native draft writer** that creates a CapCut desktop draft folder from the existing `edl.json`, writes `draft_info.json` plus compatibility `draft_content.json`, copies media into `assets/`, writes `draft_meta_info.json`, and updates `root_meta_info.json`. Do not drive CapCut Web's timeline UI. Do not depend on CapCut templates as the primary automation layer.

Direct draft JSON writing from Node is viable for CapCut International 9.2.0 on macOS, but it should be implemented as a conservative schema writer with a fixture/template base and validation. A Python library is not required for the core pipeline. The best outside reference implementation for this repo is `capcut-cli`, because it is JavaScript/TypeScript, writes local draft JSON, supports macOS `draft_info.json`, has zero runtime dependencies, exposes library APIs, and has explicit version detection/guards. Its own version matrix still marks CapCut 9.x as expected-compatible rather than fixture-tested, so we should validate against local CapCut 9.2.0 before bulk use.[^capcut-cli-readme][^capcut-cli-version]

Top risks:

1. **Schema drift / app migration:** CapCut 9.x is undocumented, and local app updates can migrate drafts. Pin the CapCut build, keep known-good draft fixtures, and verify every generated draft before bulk generation.[^capcut-cli-version]
2. **Decorative resources:** effects, transitions, stickers, text bubbles, fonts, and template placeholders depend on internal `effect_id` / `resource_id` catalogs. IDs can differ by app namespace/version and are not public API.[^capcut-cli-effects][^capcut-cli-diffs]
3. **Text and speed invariants:** text uses JSON-in-JSON with UTF-16 byte ranges, and speed requires source/target timerange math. Generate these through helper functions, not ad hoc string edits.[^capcut-cli-schema][^pycapcut-readme]

## 1. Draft Schema: Minimum Viable Project

### Files and location on macOS

CapCut desktop drafts on this machine are expected under:

```text
~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<draft-folder>/
```

For macOS CapCut, the canonical project JSON is typically `draft_info.json`. Windows CapCut commonly uses `draft_content.json`. Tooling should write both with identical content for compatibility unless local testing proves CapCut 9.2.0 only wants one. `capcut-cli` documents this exact platform split and auto-detects either file.[^capcut-cli-schema]

The visible project list is not just a folder scan. A usable generated draft should also have:

```text
draft_meta_info.json
root_meta_info.json              # in the parent com.lveditor.draft folder
assets/video/
assets/audio/
assets/image/
```

### Timebase

CapCut stores draft times in **microseconds**. `1s = 1_000_000`. This applies to draft `duration`, segment `target_timerange`, segment `source_timerange`, transition duration, and keyframe times.[^capcut-cli-schema][^pycapcut-readme]

For speed:

```js
source_timerange.duration = target_timerange.duration * speed
```

For example, a 2.0x 1-second timeline segment consumes 2 seconds of source media. `capcut-cli` and pyCapCut both call this out explicitly.[^capcut-cli-tracks][^pycapcut-readme]

### Media references

Segments do not point directly at files. A segment points to `material_id`; the matching material in `materials.videos[]` or `materials.audios[]` has the file `path`. Paths may be absolute or project-relative under `assets/<kind>/`; a generated pipeline should copy source media into the draft's `assets/` folder and write stable relative paths when possible.[^capcut-cli-materials]

`draft_meta_info.json` does not contain the media catalog. It indexes the draft folder/file for CapCut's project list: draft id, draft name, folder path, JSON file path, root path, timestamps, and duration. Media references live in `draft_info.json` / `draft_content.json`.[^capcut-cli-factory]

### Required top-level keys

The practical minimum for a generated draft:

```jsonc
{
  "id": "draft uuid",
  "name": "project name",
  "duration": 3000000,
  "fps": 30,
  "canvas_config": { "width": 1080, "height": 1920, "ratio": "9:16" },
  "platform": { "app_source": "cc", "app_version": "9.2.0", "os": "mac" },
  "tracks": [],
  "materials": {
    "videos": [],
    "audios": [],
    "texts": [],
    "stickers": [],
    "video_effects": [],
    "transitions": [],
    "masks": [],
    "chromas": [],
    "audio_fades": [],
    "audio_effects": [],
    "canvases": [],
    "speeds": [],
    "sound_channel_mappings": [],
    "vocal_separations": [],
    "placeholders": [],
    "common_mask": []
  },
  "extra_info": { "created_via": "vzt-reel-clipper" }
}
```

`capcut-cli`'s init template is essentially this shape, with empty tracks/materials and `platform.app_source: "cc"`.[^capcut-cli-schema]

### Minimal working example

This is intentionally small but shows the core join pattern: track segment -> material id -> material path. Real output should add CapCut's default fields through helper constructors or a template base.

```jsonc
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "sports-edl-generated",
  "duration": 3000000,
  "fps": 30,
  "canvas_config": { "width": 1080, "height": 1920, "ratio": "9:16" },
  "platform": { "app_source": "cc", "app_version": "9.2.0", "os": "mac" },
  "tracks": [
    {
      "id": "track-video-1",
      "type": "video",
      "name": "main",
      "segments": [
        {
          "id": "seg-video-1",
          "material_id": "mat-video-1",
          "target_timerange": { "start": 0, "duration": 1000000 },
          "source_timerange": { "start": 12000000, "duration": 1000000 },
          "clip": {
            "rotation": 0,
            "alpha": 1,
            "scale": { "x": 1, "y": 1 },
            "transform": { "x": 0, "y": 0 },
            "flip": { "horizontal": false, "vertical": false }
          },
          "speed": 1,
          "volume": 1,
          "visible": true,
          "render_index": 0,
          "render_uniform_index": -1,
          "extra_material_refs": ["speed-video-1"],
          "common_keyframes": [],
          "uniform_scale": { "on": true, "value": 1 },
          "group_id": ""
        },
        {
          "id": "seg-video-2",
          "material_id": "mat-video-1",
          "target_timerange": { "start": 1000000, "duration": 1000000 },
          "source_timerange": { "start": 20000000, "duration": 1500000 },
          "clip": {
            "rotation": 0,
            "alpha": 1,
            "scale": { "x": 1.15, "y": 1.15 },
            "transform": { "x": 0, "y": -0.04 },
            "flip": { "horizontal": false, "vertical": false }
          },
          "speed": 1.5,
          "volume": 1,
          "visible": true,
          "render_index": 0,
          "render_uniform_index": -1,
          "extra_material_refs": ["speed-video-2"],
          "common_keyframes": [],
          "uniform_scale": { "on": true, "value": 1.15 },
          "group_id": ""
        }
      ],
      "attribute": 0,
      "flag": 0,
      "is_default_name": true
    },
    {
      "id": "track-text-1",
      "type": "text",
      "name": "titles",
      "segments": [
        {
          "id": "seg-text-1",
          "material_id": "mat-text-1",
          "target_timerange": { "start": 500000, "duration": 1500000 },
          "source_timerange": { "start": 0, "duration": 1500000 },
          "clip": {
            "rotation": 0,
            "alpha": 1,
            "scale": { "x": 1, "y": 1 },
            "transform": { "x": 0, "y": -0.72 },
            "flip": { "horizontal": false, "vertical": false }
          },
          "speed": 1,
          "volume": 1,
          "visible": true,
          "render_index": 1,
          "render_uniform_index": -1,
          "extra_material_refs": [],
          "common_keyframes": [],
          "uniform_scale": { "on": true, "value": 1 },
          "group_id": ""
        }
      ],
      "attribute": 0,
      "flag": 0,
      "is_default_name": true
    },
    {
      "id": "track-audio-1",
      "type": "audio",
      "name": "music",
      "segments": [
        {
          "id": "seg-audio-1",
          "material_id": "mat-audio-1",
          "target_timerange": { "start": 0, "duration": 3000000 },
          "source_timerange": { "start": 0, "duration": 3000000 },
          "clip": null,
          "speed": 1,
          "volume": 0.85,
          "visible": true,
          "render_index": 0,
          "render_uniform_index": -1,
          "extra_material_refs": ["speed-audio-1"],
          "common_keyframes": [],
          "group_id": ""
        }
      ],
      "attribute": 0,
      "flag": 0,
      "is_default_name": true
    }
  ],
  "materials": {
    "videos": [
      {
        "id": "mat-video-1",
        "type": "video",
        "material_name": "input.mp4",
        "path": "assets/video/input.mp4",
        "duration": 60000000,
        "width": 1920,
        "height": 1080
      }
    ],
    "audios": [
      {
        "id": "mat-audio-1",
        "type": "extract_music",
        "name": "beat.mp3",
        "path": "assets/audio/beat.mp3",
        "duration": 30000000,
        "wave_points": [],
        "category_id": "",
        "category_name": "local",
        "music_id": ""
      }
    ],
    "texts": [
      {
        "id": "mat-text-1",
        "type": "text",
        "content": "{\"text\":\"GAME WINNER\",\"styles\":[{\"range\":[0,11],\"size\":18,\"bold\":true,\"fill\":{\"content\":{\"solid\":{\"color\":[1,0.84,0]}}}}],\"layer_weight\":1,\"effect\":[]}",
        "font_name": "",
        "font_size": 18,
        "text_color": "#FFD700FF",
        "text_alpha": 1,
        "border_color": "#000000FF",
        "border_width": 0.08,
        "background_color": "#00000000",
        "has_shadow": true,
        "shadow_color": "#000000FF",
        "text_alignment": 1,
        "vertical": false
      }
    ],
    "speeds": [
      { "id": "speed-video-1", "type": "speed", "speed": 1, "mode": 0, "curve_speed": null },
      { "id": "speed-video-2", "type": "speed", "speed": 1.5, "mode": 0, "curve_speed": null },
      { "id": "speed-audio-1", "type": "speed", "speed": 1, "mode": 0, "curve_speed": null }
    ],
    "stickers": [],
    "video_effects": [],
    "transitions": [],
    "masks": [],
    "chromas": [],
    "audio_fades": [],
    "audio_effects": [],
    "canvases": [],
    "sound_channel_mappings": [],
    "vocal_separations": [],
    "placeholders": [],
    "common_mask": []
  },
  "extra_info": { "created_via": "vzt-reel-clipper" }
}
```

Important details:

- The JSON-in-JSON `materials.texts[].content.styles[].range` uses UTF-16 byte offsets, not Unicode character indexes. ASCII text is easy; emoji/non-Latin text must be measured correctly.[^capcut-cli-materials]
- Audio segments must have `clip: null`; video/text/sticker segments use a `clip` transform object.[^capcut-cli-tracks]
- A transition is a material in `materials.transitions[]` and is referenced from the **first** of the two joined segments via `extra_material_refs`.[^capcut-cli-effects]

### Minimal `draft_meta_info.json`

```json
{
  "draft_cover": "draft_cover.jpg",
  "draft_fold_path": "/Users/vonzellebrown/Movies/CapCut/User Data/Projects/com.lveditor.draft/sports-edl-generated",
  "draft_id": "11111111-1111-4111-8111-111111111111",
  "draft_is_ai_shorts": false,
  "draft_is_invisible": false,
  "draft_json_file": "/Users/vonzellebrown/Movies/CapCut/User Data/Projects/com.lveditor.draft/sports-edl-generated/draft_info.json",
  "draft_name": "sports-edl-generated",
  "draft_new_version": "",
  "draft_root_path": "/Users/vonzellebrown/Movies/CapCut/User Data/Projects/com.lveditor.draft",
  "draft_timeline_materials_size": 0,
  "tm_draft_create": 1786648554922000,
  "tm_draft_modified": 1786648554922000,
  "tm_draft_removed": 0,
  "tm_duration": 3000000
}
```

`root_meta_info.json` at the draft-store root should contain an array such as `all_draft_store` with a similar entry. `capcut-cli` writes the sidecar and root index because CapCut's GUI lists projects from that central index rather than from folder discovery alone.[^capcut-cli-factory]

## 2. Plain JSON vs Encoded Drafts

For **CapCut International**, the evidence points to plaintext JSON. `capcut-cli` explicitly states "CapCut International is not encrypted - only JianYing" in its encryption decision doc.[^capcut-cli-encryption] Its schema notes cover `draft_content.json` / `draft_info.json` as local JSON files.[^capcut-cli-schema]

For **JianYing 6.0+**, `draft_content.json` may be an AES-encrypted binary payload. `capcut-cli` intentionally detects but does not decrypt this because the algorithms are reverse-engineered and have shifted across releases.[^capcut-cli-encryption] pyJianYingDraft also warns that newer JianYing `draft_content.json` is often not directly readable plaintext and template loading may need a `fallback_loader`.[^pyjianying-pypi]

Detection rule:

```js
const buf = fs.readFileSync(file);
const first = buf.subarray(0, 64).toString("utf8").trimStart()[0];
if (first === "{") JSON.parse(buf.toString("utf8")); // plaintext or corrupt JSON
else treat as non-JSON/encrypted-or-binary and refuse direct writes;
```

`capcut-cli`'s documented heuristic is the same: if it does not begin with `{` and does not parse as JSON, report encrypted JianYing; if it starts with `{` but fails parsing, report corruption.[^capcut-cli-encryption]

For CapCut 8.7+ and later, there is another issue besides encryption: edits to one mirror file may be ignored if the canonical timeline is in `template-2.tmp` or `draft_meta_info.json`. `capcut-cli` inspects `draft_content.json`, `draft_info.json`, `draft_meta_info.json`, and `template-2.tmp`, selects the modern storage target, and synchronizes readable targets.[^capcut-cli-version] Our writer should run the same "canonical file discovery" check on imported/existing drafts. For newly generated drafts, write a coherent fresh folder.

There is no official ByteDance-documented reader/writer for this on-disk schema. The documented readers are community tools such as `capcut-cli`, pyCapCut, and pyJianYingDraft.

## 3. Library Comparison

| Library | Language | What it does | Maintenance/status signals | CapCut version/macOS fit | Verdict for this repo |
|---|---:|---|---|---|---|
| `sun-guannan/VectCutAPI` | Python server/API/MCP | HTTP/MCP editing service, draft export, optional cloud preview/render, draft profiles for CapCut/JianYing | README shows 221 commits, active project, Python 3.10+, FFmpeg, server process, API/MCP setup | Supports CapCut International in concept; outputs draft folders to copy. Adds service/dependency surface we do not need | Useful reference for effects/keyframes, but too heavy for "minimize dependencies" |
| `GuanYixuan/pyJianYingDraft` | Python | Mature JianYing draft generator, template mode, text/audio/video/effects/transitions, export automation for older JianYing | PyPI latest `0.3.0` released 2026-07-08, Python >=3.8, beta; GitHub has ~4.2k stars | Strong JianYing focus. Docs say Windows supports all functions; Linux/macOS support draft generation/template mode, but generated drafts still need Windows JianYing export. Newer JianYing needs fallback loader for non-plaintext templates | Not the right primary dependency for CapCut International 9.2.0 macOS |
| `GuanYixuan/pyCapCut` | Python | CapCut port of pyJianYingDraft: local video/audio/text, speed, keyframes, effects, transitions, templates | GitHub page shows only 18 commits and latest commit ~11 months ago; README says migration from pyJianYingDraft | README says Linux/macOS can install/use, but generated drafts still need Windows CapCut export. Curve speed is not supported | Good schema reference, not reliable enough as primary macOS automation |
| `renezander030/capcut-cli` | TypeScript/Node | CLI and library for local CapCut/JianYing draft JSON: create, add video/audio/text, speed, trim, masks, transitions, effects, templates, compile specs, lint, version guard | npm package present; README advertises zero deps, library import, JSON-in/out, local atomic writes; version docs include schema flags and write guards | Explicitly supports macOS `draft_info.json` path. CapCut 9.x is expected-compatible/unverified, not fixture-tested. This still makes it the closest fit for a Node CLI | Best fit and best reference. Prefer internal Node implementation borrowing its schema model, or use it as optional dependency if acceptable |

Sources: VectCutAPI README describes API/MCP, draft export, Python/FFmpeg requirements, and draft profiles.[^vectcut] pyJianYingDraft PyPI documents 2026 release, feature/version matrix, macOS limitations, and encrypted-template caveat.[^pyjianying-pypi] pyCapCut README documents its migration status, feature list, macOS/Windows-export warning, microsecond timebase, speed support, and effects caveats.[^pycapcut-readme] capcut-cli README/version docs document Node usage, library API, zero dependencies, macOS paths, canonical-file handling, and 9.x support status.[^capcut-cli-readme][^capcut-cli-version]

## 4. Templates: Velocity / Sports Edit Internals

CapCut "velocity edit" and "sports edit" templates are not a public programmable format. Practically, they are CapCut projects with:

- video/image placeholder clips,
- beat-synced trims,
- speed changes,
- text materials,
- transition/effect materials,
- possible stickers/overlays,
- locked or user-replaceable media slots depending on how the template was published.

Official help says templates are customized by replacing placeholder media in UI flows. Desktop has only limited official/built-in template use and cannot access the full TikTok/mobile/community template ecosystem.[^capcut-template-use] Official help also says replaceable material clips can be defined only on Mobile and Web, not Desktop.[^capcut-replaceable]

Programmatic options:

1. **Cloud/community template -> supplied clips:** no public API found. Treat as UI-only.
2. **Local draft-as-template:** viable. Duplicate a local draft folder, replace `materials.videos[].path` / `materials.audios[].path`, adjust segment `source_timerange`, and preserve the rest. pyCapCut exposes this style directly via `duplicate_as_template`, `replace_material_by_name`, `replace_material_by_seg`, and `replace_text`.[^pycapcut-readme]
3. **Our EDL as template:** best path. Encode the sports/velocity grammar directly from `edl.json` into draft JSON; optionally maintain a small set of local "style fixture" drafts only for extracting effect/resource ids.

Conclusion: target **draft JSON**, not CapCut's template publishing system.

## 5. Effects, Transitions, and IDs

Effects/transitions are referenced by internal identifiers in material entries:

- scene effects and filters: `materials.video_effects[]` with `effect_id`, `resource_id`, `name`, `type`, `adjust_params`, `apply_target_type`.
- transitions: `materials.transitions[]` with `effect_id`, `resource_id`, `duration`, `is_overlap`, attached to the first segment via `extra_material_refs`.
- stickers: `materials.stickers[]` with `resource_id`.
- text bubbles/fancy text: extra `bubble_effect_id`, `bubble_resource_id`, `effect_id`, `effect_resource_id` on text materials plus extra material refs in some versions.[^capcut-cli-effects]

CapCut and JianYing IDs diverge. A visual effect with the same display name may have different `effect_id` / `resource_id` by namespace; writing the wrong namespace can load but render as a no-op.[^capcut-cli-diffs]

Where to get IDs:

1. `capcut-cli` ships an `enums.json` and documents commands such as `capcut enums --transitions -H`, `--filters`, and effect commands. The docs list common transition slugs including `rgb-glitch`, `radial-blur`, `horizontal-blur`, `twinkle-zoom`, `urban-glitch`, and `shake-3`.[^capcut-cli-effects]
2. pyCapCut/pyJianYingDraft expose enum classes such as `VideoSceneEffectType`, `FilterType`, intro/outro/group animation enums, and `from_name(...)`; the README warns not every enum-listed effect is necessarily usable in the current UI.[^pycapcut-readme]
3. For items not catalogued, create a draft manually in CapCut with the desired effect, inspect `draft_info.json`, and capture the material's `effect_id` / `resource_id`. pyCapCut's `inspect_material` exists specifically for extracting resource metadata from template drafts.[^pycapcut-readme]

For sports-edit effects:

- **Zoom punch:** prefer transform keyframes (`clip.scale`, `uniform_scale.value`, `common_keyframes`) around impact frames. This avoids dependence on effect catalogs.
- **Shake:** use a catalogued scene effect/transition such as `shake-3` if present, or implement deterministic position keyframes.
- **Flash:** use an overlay/color/opacity keyframe or catalogued flash/light effect extracted from a fixture.
- **RGB split / glitch:** use transition/effect slugs such as `rgb-glitch` if available in the CapCut namespace; verify in CapCut 9.2.0.
- **Motion blur whip:** use transition slugs such as horizontal/radial blur if present; for frame-accurate sports impact moments, keyframed scale/position plus short blur transition is more reliable than a global effect.

Do not hard-code one global ID list as truth. Store a local `capcut-9.2.0-macos-effects.json` generated from verified fixtures and/or `capcut-cli` enums, with a fallback keyframe implementation for core sports grammar.

## 6. Official Automation Paths as of 2026

I found no public, self-serve official CapCut API that accepts JSON timelines and returns rendered videos or desktop projects. CapCut's public pages promote AI tools and templates, but the official help flows for templates are UI flows on Mobile/Web/Desktop, not REST or SDK automation.[^capcut-template-use][^capcut-replaceable] Third-party API analyses consistently distinguish CapCut's limited AI/business surfaces from a full video rendering API, and state that CapCut does not offer a public rendering/timeline automation API.[^json2video-capcut-api][^samautomation-capcut-api]

What appears officially sanctioned:

- **CapCut app UI:** desktop, web, mobile editing/export.
- **Templates:** Mobile/Web creation and replacement flows; Desktop limited/offline official templates.[^capcut-template-use][^capcut-replaceable]
- **Pippit/CapCut AI products:** browser/productized AI video generation, not a documented local project-generation SDK for CapCut desktop drafts.[^pippit]
- **CapCut AI API marketing pages:** public CapCut pages use "AI API" language, but I did not find concrete public endpoint docs for timeline construction, draft generation, or rendering.[^capcut-ai-api]

What is not officially sanctioned:

- local `draft_info.json` mutation,
- private web API/session-token wrappers,
- UI automation of the web editor,
- reverse-engineered decryption of JianYing encrypted drafts.

For this project, the least-bad path is local draft generation plus human review/export in CapCut desktop.

## 7. Recommended Architecture: EDL -> CapCut Project

### Pipeline

```text
edl.json
  -> validate EDL timing and assets
  -> probe media with ffprobe
  -> create draft folder under ~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<safe-name>
  -> copy/link media into assets/video and assets/audio
  -> generate draft_info.json and draft_content.json
  -> write draft_meta_info.json
  -> merge root_meta_info.json entry
  -> run schema lint / invariant checks
  -> open CapCut for human review and export
```

### Node implementation details

Use Node helpers:

- `us(seconds) = Math.round(seconds * 1_000_000)`.
- `uuid()` from `node:crypto`.
- `copyAssetDeduped(src, draft/assets/video|audio)`.
- `makeVideoMaterial`, `makeAudioMaterial`, `makeTextMaterial`.
- `makeSegment({ type, materialId, targetStartUs, targetDurUs, sourceStartUs, speed })`.
- `makeSpeedCompanion(speed)`.
- `updateRootMetaInfo(root, entry)` preserving unknown fields from existing entries.
- `writeAtomic(path, json)` using same-directory temp file and rename.

EDL mapping:

- EDL cut start/duration -> `target_timerange`.
- Source in/out -> `source_timerange`.
- Speed ramp anchored on impact -> either split into multiple constant-speed CapCut segments around impact, or generate keyframes only for visual punch while keeping media speed constant. Constant-speed segments are safer than curve-speed because pyCapCut notes curve speed is not currently supported.[^pycapcut-readme]
- Smart reframing -> per-segment `clip.transform`, `clip.scale`, `uniform_scale.value`, and optional transform keyframes.
- SFX cues -> extra audio segments on `audio` tracks with `volume` and exact `target_timerange`.
- Text overlays -> `materials.texts[]` plus text track segments.

### Dependency stance

Do **not** add Python as a required runtime dependency. This repo is already a Node CLI, and the strongest CapCut 9/macOS-aligned tool is also Node. Use `capcut-cli` in one of two ways:

1. **Reference only:** implement our own minimal writer using its documented schema and invariants.
2. **Optional dev dependency/library:** use `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"` or shell `npx capcut-cli` for validation/diagnostics. This adds less ecosystem complexity than a Python bridge.[^capcut-cli-readme]

Given the user's "minimising dependencies" requirement, start with option 1 and keep the implementation scoped to: video, audio, text, constant speed, transform keyframes, and a small verified effects catalog.

## Source Notes

The CapCut draft schema is undocumented by ByteDance. The concrete schema details above come from current community tooling docs and should be verified against local CapCut 9.2.0 fixtures before large batch generation.

[^capcut-cli-readme]: `renezander030/capcut-cli` README, local JSON, zero-dependency Node CLI/library, commands, and disclaimer: https://raw.githubusercontent.com/renezander030/capcut-cli/master/README.md
[^capcut-cli-version]: `capcut-cli` version support matrix, macOS paths, canonical file discovery, 9.x status, write guards: https://raw.githubusercontent.com/renezander030/capcut-cli/master/docs/version-support.md
[^capcut-cli-encryption]: `capcut-cli` JianYing encryption decision and detection heuristic: https://raw.githubusercontent.com/renezander030/capcut-cli/master/docs/jianying-encryption.md
[^capcut-cli-schema]: `capcut-cli` draft schema overview, top-level keys, macOS `draft_info.json`, microseconds, init template: https://www.npmjs.com/package/capcut-cli
[^capcut-cli-tracks]: `capcut-cli` tracks/segments schema documentation included in the npm package (`docs/draft-schema/01-tracks-and-segments.md`): https://www.npmjs.com/package/capcut-cli
[^capcut-cli-materials]: `capcut-cli` materials schema documentation included in the npm package (`docs/draft-schema/02-materials.md`): https://www.npmjs.com/package/capcut-cli
[^capcut-cli-effects]: `capcut-cli` effects/transitions schema documentation included in the npm package (`docs/draft-schema/04-effects-filters-stickers.md`): https://www.npmjs.com/package/capcut-cli
[^capcut-cli-diffs]: `capcut-cli` CapCut-vs-JianYing schema differences included in the npm package (`docs/draft-schema/05-version-differences.md`): https://www.npmjs.com/package/capcut-cli
[^capcut-cli-factory]: `capcut-cli` `factory.js` register/index behavior in npm package source and README: https://www.npmjs.com/package/capcut-cli
[^vectcut]: VectCutAPI README, API/MCP features, Python/FFmpeg requirements, draft export profiles: https://raw.githubusercontent.com/sun-guannan/VectCutAPI/main/README.md
[^pyjianying-pypi]: pyJianYingDraft PyPI page, release date, feature/version matrix, encrypted-template caveat, macOS limitations: https://pypi.org/project/pyjianyingdraft/
[^pycapcut-readme]: pyCapCut English README, feature list, template replacement, microsecond timebase, speed handling, effects enums, macOS caveat: https://raw.githubusercontent.com/GuanYixuan/pyCapCut/main/english_readme.md
[^capcut-template-use]: CapCut Help, "How to Use and Export Templates in CapCut?", platform template limitations: https://www.capcut.com/help/use-and-export-templates-in-capcut
[^capcut-replaceable]: CapCut Help, "How to Set Replaceable Material Clips in CapCut?", Mobile/Web only for replaceable clips and Desktop limitation: https://www.capcut.com/help/how-to-set-replaceable-material-clips
[^json2video-capcut-api]: JSON2Video analysis of CapCut API limitations: https://json2video.com/how-to/capcut-api/
[^samautomation-capcut-api]: SamAutomation analysis of CapCut API/Open Platform limitations as of 2026: https://samautomation.work/capcut-api/
[^pippit]: Pippit AI product page: https://www.pippit.ai/
[^capcut-ai-api]: CapCut AI API marketing page: https://www.capcut.com/explore/ai-api
