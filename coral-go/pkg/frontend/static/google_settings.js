/* The Google sign-in block of Settings > Storage and cleanup (#20022; the Dropbox block's pattern, dropbox_settings.js). It reads GET /api/google/status and shows
   only the state and whether the client file works: never an account id, a token or a file path. Connect opens Google's own page in a new tab; Coral then waits
   for the person's Allow by reading the status again. Disconnect ends the sign-in at Google. The block is the computer's own: through Coral Hub it says so and has
   no buttons. Every server text is put in with textContent. */

const STATUS = '/api/google/status';
const POLL_MS = 2000;
const POLL_FOR_MS = 5 * 60 * 1000; // a sign-in waits five minutes on the server side too
const $ = (id) => document.getElementById(id);
let pollTimer = null;
let pollUntil = 0;
let wired = false;
let wasPending = false;

const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
const setStatus = (t) => { const el = $('settings-google-status'); if (el) el.textContent = t; };

function note(text, link, linkText = '') {
    const el = $('settings-google-note');
    if (!el) return;
    el.textContent = '';
    if (!text) return;
    el.append(document.createTextNode(text));
    if (link) {
        const a = document.createElement('a');
        a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = linkText || link;
        el.append(document.createTextNode(' '), a);
    }
}

async function post(url) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
    let body = {};
    try { body = await r.json(); } catch { /* no body */ }
    return { ok: r.ok, status: r.status, body: body || {} };
}

function hideAll() { show('settings-google-connect', false); show('settings-google-disconnect', false); }

function render(st) {
    hideAll();
    if (st.enabled === false) { setStatus('Turn on "Google sharing (experimental)" to use Google.'); return; }
    if (!st.client_file_ok) {
        setStatus(st.client_file_set ? "Google sign-in isn't ready: the client file on this computer can't be used." : "Google sign-in isn't set up on this computer.");
        return;
    }
    if (st.signin_pending) { setStatus('Waiting for you to click Allow in Google…'); return; }
    if (st.connected) { setStatus('Connected to Google.'); show('settings-google-disconnect', true); return; }
    if (st.state === 'reconnect') { setStatus('Google needs you to sign in again.'); show('settings-google-connect', true); $('settings-google-connect').textContent = 'Reconnect Google…'; return; }
    setStatus('Not connected.');
    show('settings-google-connect', true);
    $('settings-google-connect').textContent = 'Connect Google…';
}

export async function loadGoogle() {
    wire();
    let st = null;
    try {
        const r = await fetch(STATUS, { cache: 'no-store' });
        if (r.ok) st = await r.json();
        else {
            hideAll();
            let code = '';
            try { code = String((await r.json()).code || ''); } catch { /* no body */ }
            if (code === 'local_dashboard_required' || code === 'other_user' || (r.status === 403 && !code)) setStatus('Google sign-in is set up on the computer itself, not through Coral Hub.');
            else setStatus("Couldn't read the Google connection.");
            show('settings-google', true);
            return null;
        }
    } catch { /* shown below */ }
    show('settings-google', !st || st.enabled !== false); // the block is for people who turned the switch on: while it is off it adds no words to Storage (#20265)
    if (!st) { hideAll(); setStatus("Couldn't read the Google connection."); return null; }
    render(st);
    if (st.signin_pending) {
        if (!pollTimer) { pollUntil = Date.now() + POLL_FOR_MS; poll(); }
        wasPending = true;
    } else {
        if (wasPending && st.connected) note('');
        if (wasPending && !st.connected) note('The Google sign-in timed out or was cancelled. Connect again to try once more.');
        wasPending = false;
    }
    return st;
}

export function stopGooglePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

function poll() {
    stopGooglePoll();
    pollTimer = setTimeout(async () => {
        const st = await loadGoogle();
        if (st && st.signin_pending && Date.now() < pollUntil) poll();
        else stopGooglePoll();
    }, POLL_MS);
}

const connectErrors = {
    no_client: "Google sign-in isn't set up on this computer.",
    bad_client: "Google sign-in isn't ready: the client file on this computer can't be used.",
    signin_busy: 'Another Google sign-in is already waiting. Finish it, or wait five minutes and try again.',
};

export async function connectGoogle() {
    note('');
    let res;
    try { res = await post('/api/google/connect'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) {
        const code = String(res.body.code || '');
        if (code === 'open_on_127') {
            const m = /http:\/\/127\.0\.0\.1:(\d{2,5})/.exec(String(res.body.error || ''));
            const port = m ? m[1] : (window.location.port || '8420');
            note(`Open Coral at http://127.0.0.1:${port} to connect Google:`, `http://127.0.0.1:${port}/`);
            return;
        }
        note(connectErrors[code] || "Google sign-in didn't start. Try again.");
        return;
    }
    const url = String(res.body.authorize_url || '');
    if (!url.startsWith('https://accounts.google.com/')) { note("Google sign-in didn't start. Try again."); return; }
    window.open(url, '_blank', 'noopener');
    setStatus('Waiting for you to click Allow in Google…');
    wasPending = true;
    note("If the Google tab didn't open, open it here:", url, 'Open Google to sign in'); // window.open answers null with noopener even when it opened
    pollUntil = Date.now() + POLL_FOR_MS;
    poll();
}

export async function disconnectGoogle() {
    note('');
    let res;
    try { res = await post('/api/google/disconnect'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) { note("Couldn't disconnect. Try again."); return; }
    await loadGoogle();
    if (res.body.revoked === false) note('Disconnected here, but Coral could not end its sign-in at Google. To finish, remove Coral under Third-party access in your Google account.');
}

function wire() {
    if (wired) return;
    $('settings-google-connect')?.addEventListener('click', () => { connectGoogle(); });
    $('settings-google-disconnect')?.addEventListener('click', () => { disconnectGoogle(); });
    wired = true;
}
