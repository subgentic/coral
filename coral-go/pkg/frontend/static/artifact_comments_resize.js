/* The comments column of the artifact viewer is as wide as the person wants it (#14024, the Operator: "the chat window on a document review width can be too small and hard to read for longer messages"). A separator on the panel's left edge:
 * drag it, or focus it and use the arrow keys (Left widens, Right narrows, Shift for a big step, Home the narrowest, End the widest), double-click or Enter to go back to the default. The width is between MIN (340 px) and 60% of the viewer, and the document keeps
 * DOC_MIN of its own; it is remembered for this browser (storage wrapped, so a browser that refuses it just forgets). The default is 340 px, 420 px once the viewer is 1100 px or more (css/artifact-comments.css). A phone's bottom sheet has no separator. */
import { browserLocal } from './safe_storage.js';

export const MIN = 340, DOC_MIN = 360, SHARE = 0.6, STEP = 24, BIG_STEP = 96, KEY = 'coral-comments-panel-width';

/** The widest the panel may be in a main area `total` px wide: 60% of it, never so wide that the document has less than DOC_MIN, never less than MIN. */
export const maxWidth = total => Math.max(MIN, Math.min(Math.floor(total * SHARE), total - DOC_MIN));
export const clampWidth = (w, total) => Math.round(Math.min(maxWidth(total), Math.max(MIN, Number(w) || MIN)));

/** Add the separator before `panel` inside `main` (the viewer's flex row). `isColumn()` says whether the panel is a column now (not a phone's sheet, not closed). Returns { sync, reset }. */
export function attachPanelResize({ panel, main, isColumn, key = KEY }) {
    const bar = document.createElement('div');
    bar.className = 'ac-resize'; bar.setAttribute('role', 'separator'); bar.setAttribute('aria-orientation', 'vertical'); bar.tabIndex = 0;
    bar.setAttribute('aria-label', 'Resize the comments panel: arrow keys, double-click for the default'); bar.setAttribute('aria-controls', panel.id || '');
    bar.hidden = true; main.insertBefore(bar, panel);
    const total = () => main.getBoundingClientRect().width || 0;
    const now = () => Math.round(panel.getBoundingClientRect().width);
    const paint = () => { const t = total(); bar.setAttribute('aria-valuemin', String(MIN)); bar.setAttribute('aria-valuemax', String(maxWidth(t))); bar.setAttribute('aria-valuenow', String(now())); bar.setAttribute('aria-valuetext', `${now()} pixels wide`); };
    const apply = (w, save) => { const v = clampWidth(w, total()); panel.style.setProperty('--ac-w', v + 'px'); if (save) browserLocal.set(key, String(v)); paint(); return v; };
    const reset = () => { panel.style.removeProperty('--ac-w'); browserLocal.remove(key); requestAnimationFrame(paint); };
    const sync = () => {
        const on = !!isColumn(); bar.hidden = !on;
        if (!on) return;
        const saved = Number(browserLocal.get(key));
        if (Number.isFinite(saved) && saved > 0) panel.style.setProperty('--ac-w', clampWidth(saved, total()) + 'px'); else panel.style.removeProperty('--ac-w');
        paint();
    };
    let drag = null;
    bar.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { id: e.pointerId, right: panel.getBoundingClientRect().right }; bar.setPointerCapture(e.pointerId); bar.classList.add('ac-resizing'); e.preventDefault(); });
    bar.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) apply(drag.right - e.clientX, false); });
    const end = e => { if (!drag || (e && e.pointerId !== drag.id)) return; drag = null; bar.classList.remove('ac-resizing'); apply(now(), true); };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end); bar.addEventListener('lostpointercapture', end);
    bar.addEventListener('dblclick', reset);
    bar.addEventListener('keydown', e => {
        const big = e.shiftKey ? BIG_STEP : STEP;
        if (e.key === 'ArrowLeft') apply(now() + big, true);
        else if (e.key === 'ArrowRight') apply(now() - big, true);
        else if (e.key === 'Home') apply(MIN, true);
        else if (e.key === 'End') apply(maxWidth(total()), true);
        else if (e.key === 'Enter') reset();
        else return;
        e.preventDefault(); e.stopPropagation();
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!bar.hidden) { const saved = Number(browserLocal.get(key)); if (Number.isFinite(saved) && saved > 0) panel.style.setProperty('--ac-w', clampWidth(saved, total()) + 'px'); paint(); } }).observe(main); // a smaller window keeps the document its room
    return { sync, reset, bar };
}
