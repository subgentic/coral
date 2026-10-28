/* Presentation evidence only: never import this into send/approval/queue logic.
 * The backend wait remains authoritative while a Codex footer quiets attention. */
export const DISPLAY_HINT_MAX_AGE_MS = 10_000;
export function hasWorkingDisplayHint(s, now = Date.now()) {
    if (!s || s.agent_type !== 'codex' || s.display_activity_hint !== 'working' || !s.waiting_for_input || s.waiting_kind !== 'permission'
        || s.sleeping || s.archived || s.needs_login || s.stuck || s.not_started) return false;
    if (typeof s.display_activity_hint_at !== 'string' || typeof s.waiting_since !== 'string') return false;
    const at = Date.parse(s.display_activity_hint_at), since = Date.parse(s.waiting_since);
    const age = now - at;
    return Number.isFinite(at) && Number.isFinite(since) && at - since >= 3000 && age >= 0 && age < DISPLAY_HINT_MAX_AGE_MS;
}

// Expire attention suppression even if the socket stalls and no new row arrives.
// The event only repaints existing UI state; it never sends input or changes a wait.
const expiries = new Map();
export function trackDisplayHint(s) {
    if (typeof document === 'undefined' || !s?.session_id) return;
    const key = JSON.stringify([s.server || 'local', s.session_id]);
    const previous = expiries.get(key);
    if (!hasWorkingDisplayHint(s)) {
        if (previous) {
            clearTimeout(previous.timer); expiries.delete(key);
            // The lease ran out and this call is the first to see it, before the timer fired: the repaint the timer owed is sent here, once (a poll in that millisecond used to cancel it, and the row kept its quiet look, #9825).
            if (Date.now() >= previous.until) setTimeout(() => document.dispatchEvent(new CustomEvent('coral:display-hint-expired')), 0);
        }
        return;
    }
    const until = Date.parse(s.display_activity_hint_at) + DISPLAY_HINT_MAX_AGE_MS;
    if (previous?.until === until) return;
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
        expiries.delete(key);
        document.dispatchEvent(new CustomEvent('coral:display-hint-expired'));
    }, Math.max(0, until - Date.now()) + 1);
    expiries.set(key, { timer, until });
}
export function needsInputAttention(s) {
    trackDisplayHint(s);
    return !!s?.waiting_for_input && !hasWorkingDisplayHint(s);
}
