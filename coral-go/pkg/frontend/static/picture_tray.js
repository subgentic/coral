/* One picture tray for existing upload routes. Callers own the draft, transport and destination;
 * this view never uploads, sends or infers a currently selected computer. Loaded only with pictures. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('pictures.css');
const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
export function drawPictureTray(host, items, { remove, retry, markUp, open, removeClass = '' } = {}) {
    host.classList.add('picture-tray');
    host.replaceChildren(...items.map((it, i) => {
        const card = el(host.tagName === 'UL' ? 'li' : 'div', `ac-thumb image-attachment ac-thumb-${it.state || 'ready'}`);
        const name = it.name || it.filename || 'Picture'; card.title = name;
        const img = el('img', 'ac-thumb-img'); img.src = it.previewUrl; img.alt = name;
        if (open) { const b = el('button', 'image-attachment-open'); b.type = 'button'; b.setAttribute('aria-label', `Enlarge image${items.length > 1 ? ' ' + (i + 1) : ''}: ${name}`); b.addEventListener('click', () => open(i)); b.append(img); card.append(b); } else card.append(img);
        const label = el('span', 'picture-name', name); card.append(label);
        const actions = el('div', 'picture-actions');
        const button = (cls, text, label, fn) => { const b = el('button', `btn btn-small ${cls}`, text); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', fn); actions.append(b); return b; };
        if (markUp && it.state === 'ready') {
            const b = button('ac-thumb-markup', '', `Mark up ${name}`, () => markUp(i));
            const icon = el('span', 'material-icons', 'edit'); icon.setAttribute('aria-hidden', 'true'); b.append(icon);
        }
        if (retry && it.state === 'failed') button('picture-retry', 'Retry', `Retry ${name}`, () => retry(i));
        button(`ac-thumb-remove image-attachment-remove ${removeClass}`, '×', `Remove ${name}`, () => { remove(i); const next = host.querySelector('.ac-thumb-remove') || host.closest('form')?.querySelector('textarea'); next?.focus(); });
        card.append(actions);
        const words = it.state === 'uploading' ? 'Uploading…' : it.state === 'failed' ? it.error || 'Picture not uploaded. Retry or remove it.' : '';
        if (words) { const s = el('span', 'ac-thumb-state' + (it.state === 'uploading' ? ' image-uploading' : ''), words); s.setAttribute('role', it.state === 'failed' ? 'alert' : 'status'); card.append(s); }
        return card;
    }));
}
