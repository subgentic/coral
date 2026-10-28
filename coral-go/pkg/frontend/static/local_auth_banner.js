/* A red banner while local sign-in is off, and an amber one while no password is set (#10061) (#4291, Security's #4288): with CORAL_STRICT_LOCAL_AUTH=0 any program on this computer can use
 * Coral without a credential, and the person at the dashboard should know. GET /api/system/auth-status says so with strict_local_auth
 * (false); a missing field or an older server shows nothing, and the Coral Hub's view never does (the Hub is not this computer's door).
 * The banner has no close button: it goes when sign-in is turned back on. It is a note, only ever shown or hidden, never rewritten: the page start is quiet,
 * and when it appears after the first read its sentence is announced once, not again on the polls that find nothing changed (#10374). */
import { isCloud } from './server_base.js';
import { state } from './state.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';

const CHECK_MS = 60000;
let started = false;
let read = false; // the first answer is in: what appears after it is a change

/** What the bar has to say: { off, noPassword } from the auth status, or null when the answer could not be read (a failed poll, a non-ok status, a body that is not JSON): that is not an answer, so it leaves the bar as it is
 *  rather than hiding a warning that is true. off: sign-in is off (strict_local_auth false); noPassword: password_set is false, which the page could not tell the person once Not now was pressed (#10061, D2). */
async function authState() {
    try {
        const r = await fetch('/api/system/auth-status', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return null;
        const st = await r.json();
        if (!st || typeof st !== 'object') return null;
        return { off: st.strict_local_auth === false, noPassword: st.password_set === false && st.authenticated !== false, local: st.local === true };
    } catch { return null; }
}

export async function checkLocalAuthBanner() {
    const banner = document.getElementById('local-auth-banner');
    if (!banner || isCloud()) return;
    const st = await authState();
    if (!st) return;
    const first = !read; read = true;
    const show = st.off || st.noPassword;
    // Written only on a change (a poll that finds the same thing touches nothing); a note, so the page start is quiet (#10374)
    const words = st.off ? 'off' : 'nopw';
    for (const span of banner.querySelectorAll('[data-auth-state]')) { const want = span.dataset.authState !== words; if (span.hidden !== want) span.hidden = want; }
    const remote = document.getElementById('local-auth-remote'), remoteOn = st.noPassword && !st.off && !!(state.privacyStatus && state.privacyStatus.remote_access_enabled); // with remote access on, other devices need the setup code to make the first password
    if (remote && remote.hidden === remoteOn) remote.hidden = !remoteOn;
    const btn = document.getElementById('local-auth-set-password');
    if (btn && btn.hidden === st.noPassword) btn.hidden = !st.noPassword;
    if (btn && btn.dataset.local !== String(st.local)) btn.dataset.local = String(st.local); // the form's Not now is final only on this computer
    if (banner.classList.contains('notice-error') !== st.off) { banner.classList.toggle('notice-error', st.off); banner.classList.toggle('notice-warn', !st.off); } // red when sign-in is off (a risk); amber for no password with sign-in on (a nudge, the safe default)
    if (banner.hidden === show) {
        banner.hidden = !show;
        // The page start is quiet, but a bar that appears after the first read is heard: its sentence, once, in the notices' polite status (#10374)
        if (show && !first) importOnce('./notifications.js').then(m => m.announceNotice(banner.textContent.replace(/\s+/g, ' ').replace(/^\s*warning\s*/i, '').trim())).catch(() => {});
    }
}

/** Start the checks; resolves when the first answer is in (the page waits for it, briefly, so the banner's strip is settled before the terminal is sized). */
export function startLocalAuthBanner() {
    if (started || isCloud()) return Promise.resolve();
    started = true;
    pollEvery(checkLocalAuthBanner, CHECK_MS);
    document.addEventListener('coral:password-changed', () => { checkLocalAuthBanner(); }); // a password was set or changed: the bar asks again at once
    return checkLocalAuthBanner();
}
