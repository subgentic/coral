/* What the page does when an agent needs the person or finishes a reply while this tab is in the background (#10068, desktop pass #10063):
 * a count in the tab title ("(2) Coral"), the opt-in desktop alert (desktop_notify.js, which decides which kinds and whether there is a sound), and
 * nothing at all while the tab is visible (the page's own toasts and rows cover that). The count is cleared when the person comes back.
 * It carries a number, never a name or text. */
import { notifyAttention } from './desktop_notify.js';

export const KIND_NEEDS_INPUT = 'needs_input';
export const KIND_REPLY = 'finished';

const PREFIX = /^\(\d{1,3}\+?\) /;
let count = 0, total = 0; // count: what arrived while the tab was hidden; total: what is waiting for the person now (the Inbox's number), kept up to date by the page

function paint() {
    if (typeof document === 'undefined') return;
    const bare = document.title.replace(PREFIX, '');
    const n = document.hidden ? Math.max(count, total) : 0; // in the background the title carries what still waits, not only what arrived: a question that came while the person was away stays counted until it is answered (#11837)
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${bare}` : bare;
}

/** Something wants the person: counted in the title and, when this browser opted in, raised as a desktop alert. Only while this tab is in the background. Returns whether it was counted. */
export function noteAttention(kind, who = {}) {
    if (typeof document === 'undefined' || !document.hidden) return false;
    count++;
    paint();
    notifyAttention(kind, who);
    return true;
}

/** The Inbox's number of things waiting for the person (the tab badge's): in the title while the tab is in the background. */
export function setAttentionTotal(n) {
    if (total === n) return;
    total = n;
    paint();
}

/** The person is back: the count goes. */
export function clearAttention() {
    if (count === 0) return;
    count = 0;
    paint();
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) clearAttention(); paint(); }); // hidden: the total shows; visible: the title is bare
    if (typeof window !== 'undefined') window.addEventListener('focus', () => { if (!document.hidden) clearAttention(); });
}
