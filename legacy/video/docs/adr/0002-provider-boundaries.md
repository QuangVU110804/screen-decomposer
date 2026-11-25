# ADR 0002 — Provider boundaries and deterministic fallbacks

Date: 2026-09-01

Status: Accepted

## Decision

The Node pipeline owns orchestration and uses narrow provider contracts:

- scene analysis: multi-image structured Vision contract;
- segmentation: crop plus semantic prompt to mask/alpha result;
- inpainting: image plus missing-region mask to reconstructed image;
- OCR: text content/style returned by the scene analyzer for MVP;
- embedding/dedupe: perceptual hash, chroma, mask shape and conservative semantic similarity fallback.

Segmentation and inpainting support HTTP providers. Segmentation has a deterministic border-color matte fallback for development and fixtures. Inpainting first attempts temporal keyframe recovery, then an explicitly labeled local blur-fill fallback when background recovery is enabled. These local fallbacks are not claimed to match production foundation-model quality.

## Decision matrix

| Capability | Default MVP | External option | Deterministic test path |
|---|---|---|---|
| Scene transitions | FFmpeg scene score + black/fade interval | Custom detector can replace service | Inject raw events |
| Multi-image understanding | Anthropic tool-use schema | Custom scene analyzer | In-process provider override |
| Segmentation/matting | HTTP adapter or local border matte | Any service returning a grayscale mask | In-process provider override |
| Inpainting | Temporal recovery, optional HTTP/local fallback | Any service returning an image | In-process provider override |
| OCR | Scene analyzer text fields | Future dedicated OCR engine | Structured mock response |
| Dedupe | dHash + chroma + mask + semantic similarity | Future embedding provider | Deterministic local signals |

## Operational constraints

Provider audit metadata records provider/model version, latency and failures but never API keys or raw secret-bearing requests. A failed provider call is isolated to its scene or asset and can produce a `PARTIAL` job.
