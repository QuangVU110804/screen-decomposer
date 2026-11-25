# ADR 0001 — Canonical scene semantics

Date: 2026-09-01

Status: Accepted

## Decision

- A hard cut is always a scene boundary.
- Fade and dissolve intervals are retained as raw evidence and reduced to one canonical boundary at the transition midpoint.
- Minor content changes inside an otherwise stable composition do not create a scene.
- A slideshow changes scene when the primary slide changes, not while a Ken Burns zoom/pan continues on one slide.
- A talking head plus lower-third remains one scene unless the underlying shot/composition changes.
- Screen-recording scroll and cursor movement remain inside one scene until the application/page composition changes materially.
- Split-screen and motion graphics use the same rule: one continuous editing composition is one scene.
- Canonical scene time ranges use seconds and `[start, end)` semantics. They must partition the whole video without gaps or overlap.

## Consequences

Raw boundary events, confidence and merge reasons remain available for evaluation. Minimum and maximum duration may merge flashes or split overlong analysis units, but may never silently remove a time range.
