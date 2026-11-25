export function rectangleFromPoints(start, end, width, height) {
  const left = Math.max(0, Math.floor(Math.min(start[0], end[0])));
  const top = Math.max(0, Math.floor(Math.min(start[1], end[1])));
  const right = Math.min(width, Math.ceil(Math.max(start[0], end[0])));
  const bottom = Math.min(height, Math.ceil(Math.max(start[1], end[1])));
  if (start[0] === end[0] || start[1] === end[1] || right <= left || bottom <= top) return null;
  return [left, top, right - left, bottom - top];
}
