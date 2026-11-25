import {elementModeLabel} from './element-types.mjs';
export function renderGallery(container, elements, { onSelect, onOpen, onHighlight }) {
  const fragment = document.createDocumentFragment();
  for (const element of elements) {
    const card = document.createElement('article'); card.className = 'asset-card';
    card.dataset.elementId = element.id;
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'asset-preview';
    preview.setAttribute('aria-haspopup', 'dialog');
    preview.setAttribute('aria-label', `Xem vùng ${element.number}: ${element.label}`);
    const img = document.createElement('img'); img.className = 'checker'; img.src = element.thumbnailUrl;
    img.alt = ''; img.loading = 'lazy'; img.width = 64; img.height = 56;
    const info = document.createElement('span'); info.className = 'asset-info';
    const name = document.createElement('span'); name.className = 'asset-name'; name.textContent = `${element.number}. ${element.label}`;
    name.title = element.label;
    const tag = document.createElement('span'); tag.className = 'asset-tag';
    const mode = document.createElement('span'); mode.textContent = elementModeLabel(element);
    if (element.outputKind === 'crop') mode.className = 'crop';
    const size = document.createElement('span'); size.textContent = `${element.bbox[2]}×${element.bbox[3]}`;
    tag.append(mode, size); info.append(name, tag); preview.append(img, info);
    preview.addEventListener('click', () => onOpen(element));
    const label = document.createElement('label'); label.className = 'asset-select';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = element.selected !== false;
    checkbox.setAttribute('aria-label', `Chọn vùng ${element.number}: ${element.label} để tải ZIP`);
    checkbox.addEventListener('change', () => onSelect(element, checkbox.checked)); label.append(checkbox);
    card.addEventListener('focusin', () => onHighlight(element.id));
    card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget)) onHighlight(null); });
    card.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') onHighlight(element.id); });
    card.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) onHighlight(null); });
    card.append(preview, label); fragment.append(card);
  }
  container.replaceChildren(fragment);
}
