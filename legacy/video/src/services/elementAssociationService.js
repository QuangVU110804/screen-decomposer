'use strict';

function tokens(value) {
  return new Set(String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2));
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function meanBbox(element) {
  const values = (element.observations || []).map((observation) => observation.bbox).filter(Boolean);
  if (values.length === 0) return null;
  return [0, 1, 2, 3].map((index) => (
    values.reduce((sum, bbox) => sum + Number(bbox[index] || 0), 0) / values.length
  ));
}

function bboxSimilarity(left, right) {
  if (!left || !right) return 0;
  const centerDistance = Math.hypot(
    (left[0] + left[2] / 2) - (right[0] + right[2] / 2),
    (left[1] + left[3] / 2) - (right[1] + right[3] / 2)
  );
  const sizeRatio = Math.min(left[2] * left[3], right[2] * right[3]) /
    Math.max(0.000001, Math.max(left[2] * left[3], right[2] * right[3]));
  return Math.max(0, Math.min(1, sizeRatio * 0.55 + (1 - centerDistance / Math.SQRT2) * 0.45));
}

function associateElements(scenes, options = {}) {
  const threshold = options.descriptionThreshold ?? 0.72;
  const tracks = [];
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
    const scene = scenes[sceneIndex];
    for (const element of scene.elements || []) {
      const signature = tokens(`${element.type} ${element.description} ${element.text || ''}`);
      const bbox = meanBbox(element);
      let match = null;
      let matchScore = null;
      for (const track of tracks) {
        if (track.type !== element.type) continue;
        const description = jaccard(signature, track._tokens);
        const spatial = bboxSimilarity(bbox, track._bbox);
        const adjacent = sceneIndex - track._lastSceneIndex <= (options.maxSceneGap ?? 2);
        const required = element.type === 'background' ? Math.max(0.84, threshold) : threshold;
        const matched = description >= required ||
          (adjacent && description >= 0.5 && spatial >= 0.72);
        const score = description * 0.72 + spatial * 0.18 + (adjacent ? 0.1 : 0);
        if (matched && (!matchScore || score > matchScore.score)) {
          match = track;
          matchScore = { score, description, spatial, adjacent };
        }
      }
      if (!match) {
        match = {
          trackId: `track_${String(tracks.length + 1).padStart(3, '0')}`,
          type: element.type,
          description: element.description,
          occurrences: [],
          _tokens: signature,
          _bbox: bbox,
          _lastSceneIndex: sceneIndex,
        };
        tracks.push(match);
      } else {
        match._tokens = new Set([...match._tokens, ...signature]);
        match._bbox = bbox || match._bbox;
        match._lastSceneIndex = sceneIndex;
      }
      element.trackId = match.trackId;
      match.occurrences.push({ sceneId: scene.sceneId, elementId: element.elementId });
      element.association = matchScore ? {
        reason: matchScore.adjacent ? 'semantic_spatial_temporal' : 'semantic_similarity',
        similarity: Number(matchScore.score.toFixed(4)),
        descriptionSimilarity: Number(matchScore.description.toFixed(4)),
        bboxSimilarity: Number(matchScore.spatial.toFixed(4)),
        temporallyAdjacent: matchScore.adjacent,
      } : {
        reason: 'new_track',
        similarity: 0,
      };
    }
  }
  return tracks.map(({ _tokens, _bbox, _lastSceneIndex, ...track }) => track);
}

module.exports = { tokens, jaccard, meanBbox, bboxSimilarity, associateElements };
