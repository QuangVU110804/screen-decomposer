'use strict';

const STAGES = Object.freeze([
  { id: 'probing', weight: 5 },
  { id: 'detecting_scenes', weight: 12 },
  { id: 'selecting_keyframes', weight: 18 },
  { id: 'understanding_scenes', weight: 22 },
  { id: 'associating_elements', weight: 4 },
  { id: 'extracting_direct_assets', weight: 9 },
  { id: 'segmenting', weight: 10 },
  { id: 'recovering_backgrounds', weight: 5 },
  { id: 'validating_assets', weight: 5 },
  { id: 'deduplicating', weight: 3 },
  { id: 'packaging', weight: 7 },
]);

const TERMINAL_STATUSES = new Set(['done', 'partial', 'failed']);

function progressFor(stageId, fraction = 0) {
  const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
  let completed = 0;
  for (const stage of STAGES) {
    if (stage.id === stageId) return Math.min(99, Math.round(completed + stage.weight * clamped));
    completed += stage.weight;
  }
  return Math.min(99, Math.round(completed));
}

function isPipelineStage(value) {
  return STAGES.some((stage) => stage.id === value);
}

module.exports = { STAGES, TERMINAL_STATUSES, progressFor, isPipelineStage };
