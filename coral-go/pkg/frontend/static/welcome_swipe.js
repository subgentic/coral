/* Swipe a welcome row to dismiss it (#11542, the operator's change request; the mockup is #11536). A left drag on a touch screen: the row follows the finger, the word "Dismiss" shows on a strip where it was, and letting go
 * past 40% of the row's width (or on a quick flick) dismisses it; less than that and it springs back. The page still scrolls: the rows are `touch-action: pan-y`, so the browser keeps the vertical pans and hands us the
 * horizontal ones. The visible Dismiss button stays the real control (keyboard, screen reader): a swipe is a shortcut to the same dismissWelcome, and only a swipe offers Undo (in the toast, which stays 30 seconds: the notices' rule for a toast with an action). Lazy: the Inbox loads
 * it for a touch screen when a row has a Dismiss (inbox_sidebar.js), nothing at start. With reduced motion the row neither slides nor springs. */
import { state } from './state.js';
import { dismissWelcome, save } from './welcome_items.js';
import { showToast, announceNotice } from './notifications.js';

const START_PX = 10, COMMIT = 0.4, FLICK = 0.5, FLICK_MIN_PX = 40; // FLICK: px per ms

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Put an item back: it comes off the dismissed list and the items are on again (a dismissal that was the last one had turned them off). */
function undo(id) {
    const rest = String((state.settings || {}).inbox_welcome_done || '').split(',').map(s => s.trim()).filter(x => x && x !== id).join(',');
    save({ inbox_welcome_done: rest, inbox_welcome: 'on' }); // welcome_items' own saver: in order with the dismissal's save, and the page's settings follow
    document.dispatchEvent(new CustomEvent('coral:welcome-changed'));
}

/** Listen for drags of the rows that carry data-welcome-id (a row with a Dismiss) or a Dismiss of their own. The listeners sit on the list's persistent outer box (the Inbox's #group-table-view, with its gutter) and are added ONCE: each table build calls this with its new box, which only becomes the one the listeners read (#11765: they were added again per build, and after five folder switches one swipe ignored a file eight times). */
export function attachWelcomeSwipe(host) {
    const scope = host.closest('#group-table-view') || host; // the list's own box and the gutter around it
    scope._swipeHost = host; // the table on screen now
    if (scope._welcomeSwipe) return;
    scope._welcomeSwipe = true;
    const cur = () => (scope._swipeHost && scope._swipeHost.isConnected ? scope._swipeHost : null);
    let drag = null;
    const back = (row, strip) => { row.style.transition = calm() ? 'none' : 'transform .15s ease-out'; row.style.transform = ''; strip.remove(); };
    scope.addEventListener('pointerdown', e => {
        // a finger that starts in the list's side gutter (a 360 px phone has 16 px of it right of the row, and a driver drags from the edge) is on the row at that height (#11765)
        const rowAt = y => [...(cur() || scope).querySelectorAll('tr[data-welcome-id], tr[data-key]')].find(r => { const b = r.getBoundingClientRect(); return y >= b.top && y <= b.bottom; });
        const row = e.pointerType === 'touch' && (e.target.closest('tr[data-welcome-id], tr[data-key]') || (scope.contains(e.target) && !e.target.closest('button, a, input, select, textarea, .dt-bar, .gt-toolbar') ? rowAt(e.clientY) : null));
        if (row && !row.dataset.welcomeId && !row.querySelector('.inbox-review-actions')?._ignore) return; // a row with nothing to ignore is not swiped (#11642)
        if (!row || drag) return;
        drag = { row, id: row.dataset.welcomeId, box: row.querySelector('.inbox-review-actions'), x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, on: false, strip: document.createElement('div') };
        drag.strip.className = 'inbox-swipe-strip'; drag.strip.setAttribute('aria-hidden', 'true'); drag.strip.textContent = 'Dismiss';
    });
    scope.addEventListener('pointermove', e => {
        if (!drag || e.pointerType !== 'touch') return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.on) {
            if (Math.abs(dy) > START_PX && Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // mostly vertical: the page's
            if (-dx < START_PX) return;
            drag.on = true; drag.row.style.transition = 'none'; drag.row.setPointerCapture?.(e.pointerId);
            const h = cur() || scope, box = drag.row.getBoundingClientRect(), at = h.getBoundingClientRect();
            Object.assign(drag.strip.style, { top: `${box.top - at.top}px`, height: `${box.height}px` });
            h.style.position ||= 'relative'; h.append(drag.strip);
        }
        drag.dx = Math.min(0, dx);
        drag.row.style.transform = `translateX(${drag.dx}px)`; drag.strip.style.width = `${-drag.dx}px`;
    });
    const end = e => {
        if (!drag) return;
        const d = drag; drag = null;
        if (!d.on) return;
        const wide = d.row.getBoundingClientRect().width || 1, fast = -d.dx / Math.max(1, e.timeStamp - d.t), mute = ev => ev.stopPropagation();
        d.row.addEventListener('click', mute, true); setTimeout(() => d.row.removeEventListener('click', mute, true), 100); // the lift of the finger is not a tap on a button
        if (e.type === 'pointerup' && (-d.dx > wide * COMMIT || (fast > FLICK && -d.dx > FLICK_MIN_PX))) {
            d.strip.remove(); d.row.style.transform = '';
            if (!d.id) { d.box._ignore(d.row); return; } // a review, a question or a failed run: the row's own Dismiss, which says it and offers Undo itself (#11642)
            const title = (d.row.querySelector('.inbox-welcome-name')?.firstChild?.textContent || 'the item').trim();
            dismissWelcome(d.id);
            showToast(`Dismissed: ${title}`, false, undefined, { action: { label: 'Undo', onClick: () => undo(d.id) } });
            announceNotice(`Dismissed: ${title}. Undo is in the notice.`); // read out politely: the toast is not a live region of its own
        } else back(d.row, d.strip);
    };
    scope.addEventListener('pointerup', end);
    scope.addEventListener('pointercancel', end);
}
