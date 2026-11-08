/* The Dropbox backup block of Settings > Storage and cleanup (#14609, Dropbox stage 3b; design v33 §4, §4b and §11). It reads GET /api/dropbox/status
   (never a token) and offers one next step for each state: Connect, Reconnect, Disconnect, Switch to the new account, Take over. Connect opens Dropbox's
   own page in a new tab; Coral then waits for the person's Allow by reading the status again. Every server text is put in with textContent. */

const STATUS = '/api/dropbox/status';
const POLL_MS = 2000;
const POLL_FOR_MS = 5 * 60 * 1000; // a sign-in waits five minutes on the server side too

const $ = (id) => document.getElementById(id);
let pollTimer = null;
let pollUntil = 0;
let wired = false;
let wasPending = false; // a sign-in was waiting at the last read: if it is gone and nothing connected, it timed out

function show(id, on) {
    const el = $(id);
    if (el) el.hidden = !on;
}

function setStatus(text) {
    const el = $('settings-dropbox-status');
    if (el) el.textContent = text;
}

// note shows a sentence under the buttons; link (optional) is a URL the sentence ends with, shown as a link (in a new tab when newTab). The note is a
// live region that is always rendered (empty when there is nothing to say), so a screen reader reads each new sentence.
function note(text, link, newTab = false, linkText = '') {
    const el = $('settings-dropbox-note');
    if (!el) return;
    el.textContent = '';
    if (!text) return;
    el.append(document.createTextNode(text));
    if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.textContent = linkText || link;
        if (newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        el.append(document.createTextNode(' '), a);
    }
}

async function post(url) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
    let body = {};
    try { body = await r.json(); } catch { /* no body */ }
    return { ok: r.ok, status: r.status, body: body || {} };
}

// render shows one state. st is the status answer.
function render(st) {
    for (const id of ['settings-dropbox-connect', 'settings-dropbox-disconnect', 'settings-dropbox-switch', 'settings-dropbox-takeover']) show(id, false);
    if (!st || !st.app_key_set) {
        setStatus("Dropbox backup isn't available in this build.");
        return;
    }
    if (st.switch_pending) {
        const sw = st.switch_pending || {};
        setStatus(`This is a different Dropbox account (${sw.to || 'new account'}) from the one before (${sw.from || 'old account'}). Switch to it, or connect again with the old one.`);
        show('settings-dropbox-switch', true);
        show('settings-dropbox-connect', true);
        $('settings-dropbox-connect').textContent = 'Connect Dropbox…';
        return;
    }
    if (st.connected && st.looks_like_copy) {
        setStatus('This Coral looks like a copy of one that backs up to Dropbox (a copied or restored data folder), so the backup is paused here. If this is now the computer you use, Take over: Coral records this computer as the one that backs up. If the original is still in use, leave it paused.');
        show('settings-dropbox-takeover', true);
        return;
    }
    if (st.connected) {
        setStatus(`Connected to Dropbox (${st.account_id || 'account'}).`);
        show('settings-dropbox-disconnect', true);
        return;
    }
    if (st.signin_pending) {
        setStatus('Waiting for you to click Allow in Dropbox…');
        return;
    }
    const connect = $('settings-dropbox-connect');
    if (st.state === 'reconnect') {
        setStatus('Coral lost access to your Dropbox. Your files are safe on this computer.');
        connect.textContent = 'Reconnect';
    } else {
        setStatus('Not connected.');
        connect.textContent = 'Connect Dropbox…';
    }
    show('settings-dropbox-connect', true);
}

// loadDropbox reads the status and shows it; it returns the status (or null when it could not be read).
export async function loadDropbox() {
    wire();
    let st = null;
    try {
        const r = await fetch(STATUS, { cache: 'no-store' });
        if (r.ok) st = await r.json();
    } catch { /* shown below */ }
    if (!st) {
        setStatus("Couldn't read the Dropbox connection.");
        return null;
    }
    render(st);
    if (st.signin_pending) {
        // A sign-in already waits (Settings opened again, or reloaded): keep reading the status (UI Reviewer's MUST 1 on #14654).
        if (!pollTimer) { pollUntil = Date.now() + POLL_FOR_MS; poll(); }
        wasPending = true;
    } else {
        if (wasPending && !st.connected && !st.switch_pending) {
            note('The Dropbox sign-in timed out or was cancelled. Connect again to try once more.'); // MUST 2: say it, with Connect shown by render
        }
        wasPending = false;
    }
    return st;
}


// polling marks the block while the status is read again for a waiting sign-in (data-polling).
function polling(on) {
    const el = $('settings-dropbox');
    if (el) el.dataset.polling = on ? '1' : '0';
}

export function stopDropboxPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    polling(false);
}

// poll reads the status every two seconds while a sign-in waits, and stops when it ends or after five minutes.
function poll() {
    stopDropboxPoll();
    polling(true);
    pollTimer = setTimeout(async () => {
        const st = await loadDropbox();
        if (st && (st.signin_pending || (!st.connected && !st.switch_pending && Date.now() < pollUntil)) && Date.now() < pollUntil) poll();
        else stopDropboxPoll();
    }, POLL_MS);
}

const connectErrors = {
    no_app_key: "Dropbox backup isn't available in this build.",
    signin_busy: 'Another Dropbox sign-in is already waiting. Finish it, or wait five minutes and try again.',
};

export async function connectDropbox() {
    note('');
    let res;
    try { res = await post('/api/dropbox/connect'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) {
        // The server's error envelope: {"error": <the sentence>, "code": <the code to match on>} (writeError, #5262).
        const code = String(res.body.code || '');
        if (code === 'open_on_127') {
            const m = /http:\/\/127\.0\.0\.1:(\d{2,5})/.exec(String(res.body.error || ''));
            const port = m ? m[1] : (window.location.port || '8420');
            note(`Open Coral at http://127.0.0.1:${port} to connect Dropbox:`, `http://127.0.0.1:${port}/`);
            return;
        }
        note(connectErrors[code] || "Dropbox sign-in didn't start. Try again.");
        return;
    }
    const url = String(res.body.authorize_url || '');
    if (!url.startsWith('https://www.dropbox.com/')) { note("Dropbox sign-in didn't start. Try again."); return; }
    const tab = window.open(url, '_blank', 'noopener');
    setStatus('Waiting for you to click Allow in Dropbox…');
    wasPending = true;
    if (!tab) {
        // The browser blocked the new tab (MUST 3): the same page as a link the person opens.
        note('Your browser blocked the Dropbox tab. Open it here:', url, true, 'Open Dropbox to sign in');
    }
    pollUntil = Date.now() + POLL_FOR_MS;
    poll();
}

export async function disconnectDropbox() {
    note('');
    let res;
    try { res = await post('/api/dropbox/disconnect'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) { note("Couldn't disconnect. Try again."); return; }
    await loadDropbox();
    if (res.body.revoked === false) {
        note('Disconnected here, but Coral could not end its sign-in at Dropbox. To finish, remove Coral under Connected apps in your Dropbox settings.');
    }
}

async function confirmSwitch() {
    note('');
    let res;
    try { res = await post('/api/dropbox/switch'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) { note('The switch is no longer waiting. Connect again.'); }
    await loadDropbox();
}

async function takeOver() {
    note('');
    let res;
    try { res = await post('/api/dropbox/takeover'); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) note("Couldn't take over. Try again.");
    await loadDropbox();
}

function wire() {
    if (wired) return;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { fn(); }); };
    on('settings-dropbox-connect', connectDropbox);
    on('settings-dropbox-disconnect', disconnectDropbox);
    on('settings-dropbox-switch', confirmSwitch);
    on('settings-dropbox-takeover', takeOver);
    wired = true;
}
