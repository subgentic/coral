/* The right dock's width limits, and a right-hand column that is resized like it: a handle on its left edge dragged with makeDraggable, the width kept where the window has room and remembered.
 * The agent dock (sidebar.js initTaskBarResize) and a goal page's task column (goals_view.js) share the limits; the column also has the keys (Left widens, Right narrows, Home and End go to the ends) and a double click that resets it. */
import { makeDraggable } from './draggable.js';
import { browserLocal } from './safe_storage.js';

export const DOCK_MIN_WIDTH = 280;
const DOCK_MAIN_MIN_WIDTH = 240; // what the page beside it keeps

/** The widest the column may be in `row` (the window's width when the row has not been laid out). */
export function dockMaxWidth(row, mainMin = DOCK_MAIN_MIN_WIDTH) {
    const measured = row ? row.getBoundingClientRect().width : 0;
    const available = measured > 0 ? measured : window.innerWidth;
    return Math.max(DOCK_MIN_WIDTH, available - mainMin);
}

/**
 * Make `handle` resize `panel` (a column at the right end of `row`). `key` is where the width is kept; `apply(px|null)` sets it (null: back to the stylesheet's width).
 * Returns { restore() }: sets the remembered width again (after the column was drawn again, or the window changed).
 */
export function attachDockResize(handle, { panel, row, key, apply, mainMin }) { // mainMin: what the page beside the column keeps (the Inbox Artifacts' list keeps its Name column)
    const clamp = (w) => Math.min(Math.max(w, DOCK_MIN_WIDTH), dockMaxWidth(row, mainMin));
    const saved = () => { const w = parseInt(browserLocal.get(key), 10); return w >= DOCK_MIN_WIDTH ? w : 0; };
    const restore = () => { const w = saved(); apply(w ? clamp(w) : null); };
    makeDraggable(handle, {
        cursor: 'col-resize',
        onMove: (e) => clamp(row.getBoundingClientRect().right - e.clientX),
        onFlush: (v) => apply(v),
        onEnd: (v) => { if (v != null) browserLocal.set(key, Math.round(v)); },
    });
    handle.addEventListener('keydown', (e) => {
        const now = panel.getBoundingClientRect().width, step = e.shiftKey ? 96 : 24;
        const next = e.key === 'ArrowLeft' ? now + step : e.key === 'ArrowRight' ? now - step : e.key === 'Home' ? DOCK_MIN_WIDTH : e.key === 'End' ? dockMaxWidth(row, mainMin) : null;
        if (next === null) return;
        e.preventDefault();
        const w = clamp(next);
        apply(w); browserLocal.set(key, Math.round(w));
    });
    handle.addEventListener('dblclick', () => { browserLocal.remove(key); apply(null); });
    return { restore };
}
