# Legacy v1 compatibility and deprecation

Date: 2026-09-01

- Jobs without `schemaVersion: 2` are treated as `legacy-frame` results.
- Existing `GET /api/jobs/:id`, `/api/jobs/:id/assets`, `/api/jobs/:id/download` and `/assets/...` remain read-only compatibility endpoints.
- New submissions use the scene-decomposer pipeline and v2 result schema.
- The scene-first UI labels legacy results explicitly and does not reinterpret old `sceneClips` as canonical scenes.
- Removal of v1 reads requires a separately announced release after retained legacy jobs have expired. No automatic v1-to-v2 asset migration is performed because a full-frame result is not equivalent to a reusable element.
