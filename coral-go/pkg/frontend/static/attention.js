/* What the page does when an agent needs the person or finishes a reply while this tab is in the background (#10068, desktop pass #10063):
 * a count in the tab title ("(2) Coral"), the opt-in desktop alert (desktop_notify.js, which decides which kinds and whether there is a sound), and
 * nothing at all while the tab is visible (the page's own toasts and rows cover that). The count is cleared when the person comes back.
 * It carries a number, never a name or text. */
import { notifyAttention } from './desktop_notify.js';

export const KIND_NEEDS_INPUT = 'needs_input';
export const KIND_REPLY = 'finished';

const PREFIX = /^\(\d{1,3}\+?\) /;
let count = 0;

function paint() {
    if (typeof document === 'undefined') return;
    const bare = document.title.replace(PREFIX, '');
    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${bare}` : bare;
}

/** Something wants the person: counted in the title and, when this browser opted in, raised as a desktop alert. Only while this tab is in the background. Returns whether it was counted. */
export function noteAttention(kind, who = {}) {
    if (typeof document === 'undefined' || !document.hidden) return false;
    count++;
    paint();
    notifyAttention(kind, who);
    return true;
}

/** The person is back: the count goes. */
export function clearAttention() {
    if (count === 0) return;
    count = 0;
    paint();
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) clearAttention(); });
    if (typeof window !== 'undefined') window.addEventListener('focus', () => { if (!document.hidden) clearAttention(); });
}
