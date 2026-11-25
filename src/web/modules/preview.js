const NS = 'http://www.w3.org/2000/svg';
export function renderOverlay(svg, source, elements) {
  svg.replaceChildren();
  if (!source) return;
  svg.setAttribute('viewBox', `0 0 ${source.width} ${source.height}`);
  for (const element of elements) {
    if (element.imported) continue;
    const [x, y, width, height] = element.bbox;
    const rect = document.createElementNS(NS, 'rect');
    for (const [key, value] of Object.entries({ x, y, width, height, rx: 2 })) rect.setAttribute(key, value);
    rect.dataset.elementId = element.id;
    svg.append(rect);
  }
}
