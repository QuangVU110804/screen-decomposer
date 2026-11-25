# Project Reframing Instruction
## From Video Visual-Asset Extractor to Video Scene Decomposer

## 1. Purpose of This Document

This document defines the new direction of the project.

The original implementation gradually became a system that detects interesting or static frames from a video, classifies them with AI, and exports those frames.

That system is useful, but it does **not fully solve the original user problem**.

The original problem is:

> Video editors often see useful visual materials inside an edited video — characters, backgrounds, screenshots, images, graphics, overlays, text, and other reusable elements — but finding or recreating those materials manually is difficult.

The project should therefore be reframed from:

> **"Find valuable frames inside a video."**

to:

> **"Analyze an edited video scene-by-scene, identify reusable visual elements inside each scene, and extract or reconstruct those elements into reusable assets."**

The new mental model is:

**Frame Extractor → Scene Decomposer → Reusable Asset Pack**

---

# 2. Core Product Vision

The long-term product should accept:

- a YouTube URL, or
- a locally uploaded video,

and transform the video into a structured collection of scenes and reusable visual elements.

Example:

```text
Input Video
    ↓
Scene Detection
    ↓
Scene 01
Scene 02
Scene 03
    ↓
Scene Understanding
    ↓
Element Detection
    ↓
Character
Background
Screenshot
Image
Text
Graphic
Overlay
Logo
Object
    ↓
Extraction / Reconstruction
    ↓
Reusable Asset Library
```

A possible final output may look like:

```text
video_asset_pack/

├── scene_001/
│   ├── scene_preview.png
│   ├── background.png
│   ├── character_01.png
│   ├── graphic_01.png
│   ├── text_01.png
│   └── metadata.json
│
├── scene_002/
│   ├── scene_preview.png
│   ├── screenshot_01.png
│   ├── overlay_01.png
│   └── metadata.json
│
└── manifest.json
```

The product should eventually help a video editor answer:

> "What reusable visual elements exist in this scene, and can I extract them?"

A later version may also help answer:

> "Where might this visual asset have originally come from?"

However, source discovery should be treated as a separate module and **not as the first problem to solve**.

---

# 3. Important Reframing: The Scene Is the Main Unit

The current project is largely frame-oriented.

The new project should become **scene-oriented**.

Do not think about the video as:

```text
Video
 ↓
Frame
 ↓
Frame
 ↓
Frame
```

Think about it as:

```text
Video
 ↓
Scene 1
 ├── Frame A
 ├── Frame B
 ├── Frame C
 └── Frame D

Scene 2
 ├── Frame A
 ├── Frame B
 └── Frame C
```

A single frame may hide important information.

For example:

- a character may be partially occluded in one frame;
- the same character may become fully visible two seconds later;
- a background region may be hidden by a moving object;
- a graphic may animate into the scene;
- a screenshot may zoom or pan;
- text may appear gradually.

Therefore, multiple frames from the same scene should be analyzed together.

The fundamental project entity should become:

```text
Scene
 ├── time range
 ├── keyframes
 ├── detected elements
 ├── element tracks
 ├── extracted assets
 └── reconstruction metadata
```

---

# 4. The Main Technical Reality

An edited video is a **flattened output**.

Before rendering, an editor may have something like:

```text
background.png
character.png
text layer
rain overlay.mov
particle effect
color grading
camera movement
```

After rendering, all of those layers become pixels inside one video frame.

The original layer information is lost.

Therefore, the system cannot guarantee:

> "Recover the original editing layers exactly."

The technically realistic goal is:

> **Extract visible pixels when possible and reconstruct missing visual information when necessary.**

The product should explicitly distinguish between:

### 4.1 Directly Extracted

The asset exists visibly and almost completely in the video.

Examples:

- screenshot,
- product image,
- logo,
- chart,
- visible graphic.

Result quality can be high.

---

### 4.2 Segmented

The asset is visible but mixed with a background.

Examples:

- person,
- character,
- object,
- foreground decoration.

The system must generate a mask and isolate the element.

---

### 4.3 Reconstructed

Part of the asset is missing or occluded.

Examples:

- character legs hidden behind another object,
- background hidden by a presenter,
- object partially outside the frame,
- graphical element covered by text.

AI or image reconstruction may be required.

The result is an approximation and should not be presented as the original asset.

---

# 5. Product Terminology

Use the following terminology consistently.

## Scene

A continuous visual segment of a video that represents one editing composition or shot.

## Keyframe

A representative frame selected from a scene for analysis.

## Element

A visually independent component that may be useful to an editor.

Examples:

- character,
- person,
- background,
- image,
- screenshot,
- graphic,
- text,
- logo,
- object,
- overlay.

## Asset

An extracted or reconstructed reusable file produced from an element.

## Element Track

The same visual element observed across multiple frames in a scene.

## Direct Asset

An asset extracted mostly from original visible pixels.

## Reconstructed Asset

An asset containing AI-generated or inferred pixels.

---

# 6. The New Core Pipeline

The recommended architecture is:

```text
YouTube URL / Uploaded Video
            ↓
       Video Ingestion
            ↓
       Scene Detection
            ↓
       Keyframe Selection
            ↓
       Scene Understanding
            ↓
       Element Detection
            ↓
       Temporal Tracking
            ↓
   Segmentation / Matting
            ↓
 Extraction / Reconstruction
            ↓
       Asset Validation
            ↓
        Asset Library
            ↓
       Export / Search
```

Each stage should have a clear responsibility.

Do not combine all responsibilities into one AI prompt.

---

# 7. Stage 1 — Video Ingestion

This part of the existing project can largely remain.

Responsibilities:

- accept a YouTube URL;
- accept uploaded video files;
- download the video when required;
- validate file format;
- inspect duration and resolution;
- enforce size limits;
- create a processing job;
- report progress;
- handle errors.

Useful existing infrastructure should be retained rather than rewritten unnecessarily.

---

# 8. Stage 2 — Scene Detection

This should become one of the most important components.

Goal:

> Divide the video into meaningful visual scenes before trying to extract assets.

Possible signals include:

- hard cuts;
- fades;
- major visual changes;
- editing transitions;
- motion discontinuities;
- stable composition changes.

Do not rely only on "static frame" detection.

A visual asset may exist inside:

- moving camera shots;
- zooming images;
- animated charts;
- scrolling screenshots;
- moving characters;
- motion graphics.

Static detection may still be useful, but only as one signal.

Desired output:

```json
{
  "scene_id": 12,
  "start": 34.20,
  "end": 39.65
}
```

---

# 9. Stage 3 — Keyframe Selection

Do not analyze every video frame with an expensive model.

Instead, select a small number of representative frames for each scene.

Example:

```text
Scene: 10 seconds

Frame 1 → beginning
Frame 2 → major composition change
Frame 3 → middle
Frame 4 → highest visibility of main subject
Frame 5 → ending
```

The goal is not simply to pick frames at fixed intervals.

The goal is to maximize useful visual information.

Possible strategies:

- temporal sampling;
- sharpness score;
- motion score;
- frame difference;
- object visibility;
- scene composition change.

A scene may typically use approximately 3–8 keyframes depending on complexity.

---

# 10. Stage 4 — Scene Understanding

The AI vision layer should no longer ask only:

> "Is this frame an inserted image?"

Instead, it should understand the composition of the entire scene.

Example conceptual output:

```json
{
  "scene_id": 12,
  "elements": [
    {
      "id": "element_01",
      "type": "character",
      "description": "Anime-style male character on the left",
      "bbox": [0.05, 0.18, 0.32, 0.76],
      "occluded": false,
      "motion": "low",
      "extractability": "segmentable"
    },
    {
      "id": "element_02",
      "type": "background",
      "description": "Dark forest background",
      "extractability": "requires_inpainting"
    },
    {
      "id": "element_03",
      "type": "graphic",
      "description": "VS graphic in the center",
      "bbox": [0.43, 0.35, 0.15, 0.20],
      "extractability": "direct"
    }
  ]
}
```

AI should primarily perform:

- semantic classification;
- rough localization;
- scene reasoning;
- extraction difficulty estimation.

AI should **not automatically be responsible for every pixel-level operation**.

---

# 11. Stage 5 — Element Detection

The system needs to determine what independent elements exist.

Recommended initial taxonomy:

```text
person
character
background
image
screenshot
graphic
text
logo
object
overlay
unknown
```

Do not create an overly detailed taxonomy for the MVP.

The important question is:

> "Would a video editor reasonably treat this as a reusable visual element?"

This definition is more useful than purely computer-vision object categories.

For example:

A machine-learning detector may see:

```text
person
chair
monitor
table
```

But an editor may see:

```text
presenter
background
website screenshot
lower-third graphic
```

The project should optimize for the **editor's mental model**.

---

# 12. Stage 6 — Temporal Element Tracking

The same element may appear across several frames.

Example:

```text
Frame 1 → Character partially hidden
Frame 2 → Character clearly visible
Frame 3 → Character moves
Frame 4 → Character partially hidden
```

The system should recognize these observations as:

```text
Character A
```

instead of four different assets.

Tracking enables:

- choosing the clearest frame;
- combining information from multiple frames;
- detecting occlusion;
- reconstructing missing regions;
- avoiding duplicate assets.

The output may look like:

```json
{
  "track_id": "character_A",
  "frames": [
    102,
    108,
    114,
    120
  ],
  "best_frame": 114
}
```

---

# 13. Stage 7 — Segmentation and Matting

Bounding boxes are not enough.

A reusable character or object usually needs a transparent background.

Example:

```text
Original Scene
      ↓
Element Detection
      ↓
Segmentation Mask
      ↓
RGBA Asset
```

Output:

```text
character_01.png
```

with transparency.

Important technical problems include:

- hair boundaries;
- semi-transparent objects;
- motion blur;
- shadows;
- glow effects;
- anti-aliased edges;
- small details;
- overlapping elements.

This stage will strongly affect perceived output quality.

---

# 14. Stage 8 — Background Recovery

Background extraction is different from foreground extraction.

If a person covers part of the background, the original pixels are unavailable.

Pipeline:

```text
Scene
 ↓
Foreground Mask
 ↓
Remove Foreground
 ↓
Missing Region
 ↓
Inpainting / Reconstruction
 ↓
Recovered Background
```

The system must mark the result as reconstructed.

Example metadata:

```json
{
  "type": "background",
  "extraction_mode": "reconstructed",
  "reconstructed_area_ratio": 0.18
}
```

This makes the product more transparent and helps the user understand asset reliability.

---

# 15. Stage 9 — Asset Reconstruction

Some assets cannot be perfectly extracted.

Examples:

- cropped character;
- partially hidden illustration;
- object outside the video boundary;
- background behind a character;
- image covered by subtitles.

Reconstruction should be optional and clearly identified.

Possible output states:

```text
EXACT
SEGMENTED
RECONSTRUCTED
FAILED
```

Never silently mix AI-generated pixels with original pixels without telling the user.

---

# 16. Stage 10 — Text and Graphics

Text should not automatically be treated like an image.

For text elements, consider extracting:

```text
content
bounding box
font estimate
font size estimate
color
alignment
style
```

Example:

```json
{
  "type": "text",
  "content": "THE BATTLE BEGINS",
  "position": [0.30, 0.08],
  "estimated_style": {
    "weight": "bold",
    "alignment": "center"
  }
}
```

For MVP, OCR plus bounding-box extraction is enough.

Font identification and complete style reconstruction can be postponed.

---

# 17. Asset Quality Scoring

Every extracted asset should receive a quality score.

Suggested factors:

- visibility;
- resolution;
- segmentation confidence;
- occlusion;
- motion blur;
- reconstruction amount.

Example:

```json
{
  "asset_id": "asset_014",
  "quality": 0.87,
  "extraction_mode": "segmented",
  "occlusion": 0.05
}
```

This makes it possible to rank assets and avoid showing unusable results first.

---

# 18. Deduplication

The same asset may appear multiple times.

Do not export:

```text
character_01.png
character_02.png
character_03.png
character_04.png
```

if all four are the same character.

Instead:

```text
Character A

Occurrences:
00:42
01:16
03:54
```

Potential deduplication signals:

- visual embeddings;
- perceptual hashing;
- segmentation similarity;
- appearance similarity;
- temporal tracking.

Deduplication should happen both:

1. inside one scene;
2. across the whole video.

---

# 19. Recommended Data Model

Use a scene-centered model.

Example:

```json
{
  "video_id": "video_001",

  "scenes": [
    {
      "scene_id": "scene_012",
      "start": 34.20,
      "end": 39.65,

      "keyframes": [
        "frame_0342.png",
        "frame_0361.png",
        "frame_0388.png"
      ],

      "elements": [
        {
          "element_id": "element_01",
          "type": "character",
          "track_id": "track_character_A",
          "extraction_mode": "segmented",
          "asset_path": "assets/character_A.png",
          "quality": 0.91
        }
      ]
    }
  ]
}
```

This model will support future features much better than a flat list of frames.

---

# 20. Recommended MVP Scope

Do **not** attempt to solve every type of visual element immediately.

The first useful MVP should support only:

1. Person / Character
2. Background
3. Image / Screenshot
4. Text / Graphic

Recommended MVP pipeline:

```text
Video Input
    ↓
Scene Detection
    ↓
3–5 Keyframes per Scene
    ↓
Scene Analysis
    ↓
Element Detection
    ↓
Segmentation
    ↓
Background Reconstruction
    ↓
Asset Gallery
    ↓
Download
```

The MVP succeeds if a user can open a scene and receive several genuinely useful reusable assets.

---

# 21. What Should Be Reused From the Existing Project

Do not throw away the current codebase.

The following concepts are still valuable:

- YouTube download;
- local upload;
- video validation;
- ffmpeg / ffprobe integration;
- job lifecycle;
- progress reporting;
- queue handling;
- retry logic;
- cleanup;
- history;
- result export;
- thumbnail generation;
- scene-change detection;
- manifest generation.

The major change should happen in the **analysis pipeline**, not necessarily in the surrounding infrastructure.

Old pipeline:

```text
Video
 ↓
Sample Frames
 ↓
Find Static Frames
 ↓
Deduplicate
 ↓
AI: Is this an inserted image?
 ↓
Save Frame
```

New pipeline:

```text
Video
 ↓
Detect Scenes
 ↓
Choose Keyframes
 ↓
Understand Scene
 ↓
Detect Elements
 ↓
Track Elements
 ↓
Segment Elements
 ↓
Reconstruct Missing Parts
 ↓
Validate Assets
 ↓
Asset Library
```

---

# 22. What Should Be Removed or Downgraded

The following ideas should no longer define the core product:

## Static Frames as the Main Signal

Static detection can remain as a helper but should not control recall.

## "Interesting Frame" as the Main Output

A frame is only evidence used to produce assets.

The product output should be reusable elements.

## AI Classification as the Final Step

AI classification should become an intermediate reasoning step.

## Full-Frame PNG as the Main Asset

Full frames should remain available as scene previews, but they are not the primary product output.

---

# 23. Source Finder Should Be a Separate Future Module

The original motivation includes curiosity about where an editor obtained an asset.

This is valuable, but it should be solved **after asset extraction works well**.

Future pipeline:

```text
Extracted Asset
      ↓
Visual Search
      ↓
Candidate Web Sources
      ↓
Similarity Ranking
      ↓
Possible Source Results
```

The product should say:

> "Possible source"

or:

> "Visually similar source"

instead of:

> "Original source"

unless provenance can actually be verified.

Visual similarity does not prove origin.

---

# 24. Copyright and Reuse Boundary

The project should not assume that any asset found inside a public video is automatically reusable.

A public YouTube video does not automatically mean its visual assets are copyright-free.

The tool should separate two concepts:

```text
Technical extraction
        ≠
Legal permission to reuse
```

If source discovery is added later, useful metadata may include:

```text
source URL
license information
creator
platform
reuse conditions
```

when this information is available.

The product should avoid making unsupported claims that an extracted asset is copyright-free.

---

# 25. UI Direction

The UI should be scene-first.

Recommended structure:

```text
VIDEO TIMELINE

| Scene 1 | Scene 2 | Scene 3 | Scene 4 |
                ↑

Selected Scene 3
00:42 → 00:48

┌──────────────────────────────┐
│                              │
│        Scene Preview         │
│                              │
└──────────────────────────────┘

Detected Elements

[Character] [Background] [Graphic] [Text]

┌──────────┐
│ Character│
│ Preview  │
└──────────┘
Segmented
Quality: 91%
Download

┌──────────┐
│Background│
│ Preview  │
└──────────┘
Reconstructed
Quality: 84%
Download
```

Important UI concepts:

- video timeline;
- scene navigation;
- original scene preview;
- extracted element gallery;
- element type filters;
- quality indicator;
- extraction-mode indicator;
- download per asset;
- download scene asset pack;
- download all assets.

---

# 26. Evaluation: How to Know Whether the System Is Improving

Do not evaluate the system only by whether it successfully completes a job.

Measure actual extraction quality.

Recommended metrics:

## Scene Detection

- missed scene boundaries;
- false scene boundaries.

## Element Recall

> Of all editor-useful elements visible in the scene, how many were detected?

## Element Precision

> Of all detected elements, how many are genuinely useful assets?

## Segmentation Quality

- edge accuracy;
- missing pixels;
- background contamination.

## Reconstruction Quality

- visual consistency;
- obvious artifacts;
- amount of generated content.

## Deduplication Accuracy

- duplicate assets incorrectly kept;
- different assets incorrectly merged.

## User Utility

Most important question:

> "Would an editor actually download and reuse this asset?"

This should eventually be the primary product metric.

---

# 27. Suggested Development Phases

## Phase 0 — Refactor the Mental Model

Goal:

Replace the frame-centered model with a scene-centered data model.

Tasks:

- introduce Scene;
- introduce Element;
- introduce Asset;
- change manifests;
- preserve existing ingestion and job infrastructure.

---

## Phase 1 — Reliable Scene Detection

Goal:

Produce useful scene boundaries.

Tasks:

- hard-cut detection;
- transition handling;
- scene previews;
- keyframe selection.

Do not add reconstruction yet.

---

## Phase 2 — Scene Understanding

Goal:

Detect reusable visual elements.

Tasks:

- define element taxonomy;
- use multiple keyframes;
- return element type;
- return bounding boxes;
- estimate extractability.

---

## Phase 3 — Foreground Extraction

Goal:

Produce transparent PNG assets.

Tasks:

- segmentation;
- alpha matting;
- edge cleanup;
- asset quality scoring.

Focus first on:

- people;
- characters;
- isolated graphics.

---

## Phase 4 — Background Recovery

Goal:

Produce reusable backgrounds.

Tasks:

- foreground masks;
- object removal;
- inpainting;
- reconstruction metadata.

---

## Phase 5 — Temporal Tracking

Goal:

Use multiple frames to improve extraction.

Tasks:

- same-element matching;
- best-frame selection;
- occlusion handling;
- multi-frame reconstruction;
- cross-scene deduplication.

---

## Phase 6 — Asset Library

Goal:

Make results convenient for editors.

Tasks:

- scene timeline;
- filters;
- previews;
- downloads;
- asset packs;
- history;
- search.

---

## Phase 7 — Source Discovery

Only start this phase after extraction quality is good.

Tasks:

- reverse image search;
- visual similarity search;
- candidate source ranking;
- license metadata;
- possible-source UI.

---

# 28. Recommended Priority Order

Use this priority:

```text
P0  Scene detection
P0  Scene-centered data model
P0  Keyframe selection
P0  Element detection

P1  Segmentation
P1  Character/person extraction
P1  Image/screenshot extraction
P1  Asset gallery

P2  Background reconstruction
P2  Temporal tracking
P2  Asset deduplication
P2  OCR

P3  Graphics reconstruction
P3  Font/style estimation
P3  Source discovery
P3  Editable composition export

P4  Multi-user scaling
P4  Distributed workers
```

Do not prioritize infrastructure scaling before extraction quality.

---

# 29. Questions That Must Be Answered During Development

For every major feature, ask:

### Scene

- What exactly counts as one scene?
- How do transitions affect scene boundaries?
- How many keyframes are enough?

### Element

- What does an editor consider independently reusable?
- Is this element foreground, background, text, or graphic?
- Does the element persist across several frames?

### Extraction

- Are all original pixels visible?
- Is segmentation enough?
- Is reconstruction required?
- What percentage of the result is generated?

### Quality

- Is the resolution useful?
- Are edges clean?
- Is the asset heavily blurred?
- Is the asset too occluded to be useful?

### Product

- Would an editor actually reuse this?
- Is the output easier than manually searching for the source?
- Does the tool save meaningful editing time?

These questions should guide technical decisions.

---

# 30. Non-Goals for the First Version

The first version should **not** attempt to:

- perfectly reconstruct Premiere Pro or After Effects layers;
- identify every visual object;
- find the exact original source of every asset;
- reproduce complete animation curves;
- identify every font perfectly;
- remove every visual effect;
- support unlimited video lengths;
- process many videos simultaneously;
- guarantee copyright or licensing status;
- reconstruct invisible pixels with perfect accuracy.

Keeping these out of the MVP is important.

---

# 31. Product Success Definition

The first strong version does not need to reverse-engineer an entire edited project.

It succeeds if this workflow works:

```text
User finds an interesting YouTube video
        ↓
User submits the URL
        ↓
Tool splits the video into scenes
        ↓
User selects a scene
        ↓
Tool identifies several reusable elements
        ↓
Tool extracts clean assets
        ↓
User downloads one or more assets
        ↓
User can actually use them in an editing workflow
```

That is the first meaningful product milestone.

---

# 32. Final Product Direction

The project should no longer be described primarily as:

> "A tool that finds valuable static images inside videos."

The recommended direction is:

> **A scene decomposition tool for video editors that analyzes edited videos and extracts or reconstructs reusable visual elements such as characters, backgrounds, images, screenshots, text, and graphics.**

Long-term:

> **Video → Scenes → Elements → Reusable Asset Pack → Possible Source Discovery**

The key architectural shift is:

```text
FRAME-CENTERED
      ↓
SCENE-CENTERED
      ↓
ELEMENT-CENTERED
```

The key product shift is:

```text
Find interesting frames
        ↓
Understand composition
        ↓
Extract reusable assets
```

When making future design or engineering decisions, always ask:

> **"Does this feature help us understand a scene or recover a reusable visual element?"**

If the answer is no, it is probably not a core priority for this project.
