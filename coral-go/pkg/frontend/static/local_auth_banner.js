/* A red banner while local sign-in is off (#4291, Security's #4288): with CORAL_STRICT_LOCAL_AUTH=0 any program on this computer can use
 * Coral without a credential, and the person at the dashboard should know. GET /api/system/auth-status says so with strict_local_auth
 * (false); a missing field or an older server shows nothing, and the Coral Hub's view never does (the Hub is not this computer's door).
 * The banner has no close button: it goes when sign-in is turned back on. It is a note, only ever shown or hidden, never rewritten: the page start is quiet,
 * and when it appears after the first read its sentence is announced once, not again on the polls that find nothing changed (#10374). */
import { isCloud } from './server_base.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';

const CHECK_MS = 60000;
let started = false;
let read = false; // the first answer is in: what appears after it is a change

/** true (sign-in is off), false (on, or this server does not say), or null when the answer could not be read: a failed poll (network error,
 *  a non-ok status, a body that is not JSON) is not an answer, so it leaves the banner as it is rather than hiding a warning that is true. */
async function localSigninOff() {
    try {
        const r = await fetch('/api/system/auth-status', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return null;
        const st = await r.json();
        if (!st || typeof st !== 'object') return null;
        return st.strict_local_auth === false;
    } catch { return null; }
}

export async function checkLocalAuthBanner() {
    const banner = document.getElementById('local-auth-banner');
    if (!banner || isCloud()) return;
    const off = await localSigninOff();
    if (off === null) return;
    const first = !read; read = true;
    if (banner.hidden === off) { // only a change touches it
        banner.hidden = !off;
        // The page start is quiet (the notice is a note, not an alert, #10374), but a change after the first read is heard: its sentence, once, in the notices' polite status
        if (off && !first) importOnce('./notifications.js').then(m => m.announceNotice(banner.textContent.replace(/\s+/g, ' ').replace(/^\s*warning\s*/i, '').trim())).catch(() => {});
    }
}

/** Start the checks; resolves when the first answer is in (the page waits for it, briefly, so the banner's strip is settled before the terminal is sized). */
export function startLocalAuthBanner() {
    if (started || isCloud()) return Promise.resolve();
    started = true;
    pollEvery(checkLocalAuthBanner, CHECK_MS);
    return checkLocalAuthBanner();
}
