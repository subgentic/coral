/* A dashboard tab with no sign-in session (#3939). With strict local auth an old tab, a bookmark opened before the switch or a session that ended
 * gets 401 from /api. Instead of broken views and silent failures, every poller and the live feed stop and the page goes to the /auth sign-in page,
 * which returns here once signed in (#7398; it was a "Coral now requires sign-in" dialog). A 401 that is not "signed out" (an agent-only route, an identity
 * refusal) is not handled here: see isSignedOut401 in auth_redirect.js. The Coral Hub has its own sign-in (cloud.js). */

import { state } from './state.js';
import { setSignedOut, isSignedOut } from './overload.js';
import { showToast } from './notifications.js';

/** The /auth URL for the current page: return_to is this page's own path (same origin). */
export function authUrlFor(loc) {
    const back = (loc.pathname || '/') + (loc.search || '') + (loc.hash || '');
    return '/auth?return_to=' + encodeURIComponent(back.startsWith('/') && !back.startsWith('//') ? back : '/');
}

let _checking = false;
let _waiting = null; // the toast that says nothing answers, while that is so
let _retry = 0;

/** One call to an authenticated route: 'out' when it answers 401, 'in' when it answers anything else, 'unreachable' when nothing answers. */
async function probeSession() {
    try {
        const r = await fetch('/api/settings', { cache: 'no-store', credentials: 'same-origin' });
        return r.status === 401 ? 'out' : 'in';
    } catch { return 'unreachable'; }
}

/** Decide what the 401 meant: no session -> the sign-in page, which returns here after sign-in; a false 401 (the session is fine) -> reload the page, which restores the view (#6233);
 *  no answer at all -> stay paused, say so in a line, and ask again every few seconds. */
async function settle(win) {
    if (_checking || !isSignedOut()) return false;
    _checking = true;
    try {
        const seen = await probeSession();
        if (seen === 'unreachable') {
            if (!_waiting || !_waiting.isConnected) _waiting = showToast('Coral is not answering. Trying again…', true, Infinity);
            if (!_retry) _retry = setTimeout(() => { _retry = 0; settle(win); }, 3000);
            return false;
        }
        if (_waiting) _waiting.remove();
        if (seen === 'out') win.location.replace(authUrlFor(win.location));
        else win.location.reload();
        return true;
    } finally { _checking = false; }
}

export function recheckSignedOut(win = window) { return settle(win); }

/** The page is signed out: pause the pollers and the live feed, then go to the sign-in page (no dialog in between, #7398). */
export function enterSignedOut(win = window) {
    if (isSignedOut() || win.location.pathname.startsWith('/auth')) return;
    setSignedOut(true);
    document.dispatchEvent(new CustomEvent('coral:signed-out')); // the terminal socket closes itself
    try { if (state.coralWs) state.coralWs.close(); } catch { /* already closed */ }
    settle(win);
}
