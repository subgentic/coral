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

async function post(url, method = 'POST', payload = '{}') {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: payload, cache: 'no-store' });
    let body = {};
    try { body = await r.json(); } catch { /* no body */ }
    return { ok: r.ok, status: r.status, body: body || {} };
}

// The types Dropbox backup knows (the server's closed extension map, #14655), written with their dot: one bare type name is also an icon name, and the
// icon-subset scan counts every whole string that equals one (icon_names.mjs).
const TYPES = ['.md', '.txt', '.json', '.csv', '.png', '.jpg', '.gif', '.webp', '.pdf', '.mp4'].map(t => t.slice(1));

// renderBackup shows the backup's counts and its filters (stage 4c, #14693) once connected.
function renderBackup(st, keepControls = false) {
    const on = !!(st && st.connected && !st.looks_like_copy);
    show('settings-dropbox-backup', on);
    if (!on) return;
    const b = st.backup || {};
    const parts = [];
    const n = (k) => Number(b[k] || 0);
    parts.push(`${n('backed_up')} files backed up`);
    if (n('pending')) parts.push(`${n('pending')} waiting`);
    if (n('conflict')) parts.push(`${n('conflict')} ${n('conflict') === 1 ? 'conflict' : 'conflicts'} (already in Dropbox with other content, left as they are)`);
    if (n('skipped')) parts.push(`${n('skipped')} skipped`);
    if (n('failed')) parts.push(`${n('failed')} failed`);
    if (n('private')) parts.push(`${n('private')} private, kept off Dropbox`);
    // Stage 4b, retention (#14703). A file not at its place is never said to be removed by Coral (Security's answer 1).
    if (n('retained_out')) parts.push(`${n('retained_out')} removed from Dropbox by retention (still on this computer)`);
    if (n('gone')) parts.push(`${n('gone')} no longer at ${n('gone') === 1 ? 'its place' : 'their places'} in Dropbox`);
    if (n('edited')) parts.push(`${n('edited')} edited in Dropbox, kept there`);
    let text = parts.join(', ') + '.';
    const at = Date.parse(b.last_sync || '');
    if (!Number.isNaN(at)) text += ` Last backed up ${new Date(at).toLocaleString()}.`;
    const chosenTypes = (st.filters && st.filters.types) || [];
    const filterDays = Number((st.filters && st.filters.max_age_days) || 0);
    const keep = Number((st.retention && st.retention.days) || 0);
    // While retention is on, nothing older than its window is sent (Security's point 3 on #14703): the summary says the smaller window.
    const byRetention = keep > 0 && (filterDays === 0 || keep < filterDays);
    const days = byRetention ? keep : filterDays;
    const plural = (k) => `${k} ${k === 1 ? 'day' : 'days'}`;
    text += chosenTypes.length ? ` Backing up ${chosenTypes.map(t => '.' + t).join(', ')}` : ' Backing up every type';
    text += days > 0 ? ` from the last ${plural(days)}${byRetention ? ', the retention window' : ''}.` : '.';
    // Stage 5a (#14714): edits made in Dropbox are held, never applied here until the Operator decides.
    const ed = st.edits || {};
    const heldEdits = Number(ed.open || 0);
    const waitingEdits = Number(ed.waiting || 0);
    if (heldEdits) text += ` ${heldEdits} ${heldEdits === 1 ? 'file was' : 'files were'} edited in Dropbox: Coral holds the ${heldEdits === 1 ? 'edit' : 'edits'} for you and has not changed ${heldEdits === 1 ? 'it' : 'them'} here.`;
    if (waitingEdits) text += ` ${waitingEdits} more ${waitingEdits === 1 ? 'edit waits' : 'edits wait'} in Dropbox until you decide some.`;
    if (keep > 0) {
        text += ` Keeping files in Dropbox for ${plural(keep)}.`;
        if (st.retention.waiting_for_files) text += ' Retention starts once at least 2 artifacts are backed up.';
    }
    const counts = $('settings-dropbox-counts');
    if (counts) counts.textContent = text;
    const box = $('settings-dropbox-types');
    if (box && !box.childElementCount) {
        for (const t of TYPES) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = t;
            label.append(input, document.createTextNode(` .${t}`));
            box.append(label, document.createTextNode(' '));
        }
    }
    if (keepControls) return;
    const chosen = new Set((st.filters && st.filters.types) || []);
    if (box) for (const input of box.querySelectorAll('input[type=checkbox]')) input.checked = chosen.has(input.value);
    const age = $('settings-dropbox-age');
    if (age) age.value = String((st.filters && st.filters.max_age_days) || 0);
    const ret = $('settings-dropbox-retention-days');
    if (ret && !pendingRetention) ret.value = String(keep);
}

// filterKey is what the boxes and the age say now, to tell an edit made while a save was on its way.
function filterKey() {
    const box = $('settings-dropbox-types');
    const types = box ? [...box.querySelectorAll('input[type=checkbox]')].filter(i => i.checked).map(i => i.value).sort() : [];
    return JSON.stringify([types, ($('settings-dropbox-age') || {}).value || '0']);
}

// saveDropboxFilters sends the ticked types and the age limit.
export async function saveDropboxFilters() {
    note('');
    const box = $('settings-dropbox-types');
    const types = box ? [...box.querySelectorAll('input[type=checkbox]')].filter(i => i.checked).map(i => i.value) : [];
    const days = parseInt(($('settings-dropbox-age') || {}).value || '0', 10);
    const sentKey = filterKey();
    let res;
    try { res = await post('/api/dropbox/filters', 'PUT', JSON.stringify({ types, max_age_days: Number.isFinite(days) ? days : 0 })); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) { note(String(res.body.error || "Couldn't save. Try again.")); return; }
    // The summary follows what was saved (UI Reviewer's MUST 1 on #14693), from the answer itself. The boxes and the age follow it too, unless
    // the person changed them while the save was on its way: newer edits are kept for the next Save.
    if (lastStatus) {
        lastStatus = { ...lastStatus, filters: { types: res.body.types || [], max_age_days: Number(res.body.max_age_days || 0) } };
        renderBackup(lastStatus, filterKey() !== sentKey);
    }
    note('Saved. Narrowing what is backed up never deletes what is already in Dropbox.');
}

let lastStatus = null; // the last status shown, so a saved filter updates the summary without another read

// hideAll takes every button and the backup part (with its counts) off the screen: a refused or failed read shows none of a stale state (UI Reviewer's MUST 2 on #14693).
function hideAll() {
    for (const id of ['settings-dropbox-connect', 'settings-dropbox-disconnect', 'settings-dropbox-switch', 'settings-dropbox-takeover', 'settings-dropbox-recheck']) show(id, false);
    pendingRetention = null;
    retentionSeq++;
    showRetentionConfirm(false);
    renderBackup(null);
    const counts = $('settings-dropbox-counts');
    if (counts) counts.textContent = '';
    lastStatus = null;
}

// render shows one state. st is the status answer.
function render(st) {
    hideAll();
    lastStatus = st;
    renderBackup(st);
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
    if (st.connected && st.state === 'quota_full') {
        setStatus('Your Dropbox is full, so the backup has paused. Nothing has been deleted.');
        note('Free up space in Dropbox, or get more, then Check again:', 'https://www.dropbox.com/plans', true, 'Get more Dropbox space');
        show('settings-dropbox-recheck', true);
        show('settings-dropbox-disconnect', true);
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
        else {
            // A refusal says why, read from the error code ({"error": sentence, "code": code}); never with buttons.
            let code = '';
            try { code = String((await r.json()).code || ''); } catch { /* no body */ }
            hideAll();
            if (code === 'not_available') {
                setStatus("Dropbox backup isn't available in this build.");
            } else if (code === 'local_dashboard_required' || code === 'other_user' || (r.status === 403 && !code)) {
                // Through Coral Hub (the tunnel's refusal has no code), another dashboard or another user: say where it is done instead.
                setStatus('Dropbox backup is set up on the computer itself, not through Coral Hub.');
            } else {
                setStatus("Couldn't read the Dropbox connection.");
            }
            return null;
        }
    } catch { /* shown below */ }
    if (!st) {
        hideAll();
        setStatus("Couldn't read the Dropbox connection.");
        return null;
    }
    render(st);
    if (st.signin_pending) {
        // A sign-in already waits (Settings opened again, or reloaded): keep reading the status (UI Reviewer's MUST 1 on #14654).
        if (!pollTimer) { pollUntil = Date.now() + POLL_FOR_MS; poll(); }
        wasPending = true;
    } else {
        if (wasPending && (st.connected || st.switch_pending)) note(''); // the sign-in finished: its "open it here" link is stale (#14736)
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
    // With noopener, window.open answers null even when the tab opened, so the page cannot tell a blocked tab (#14736, UI Reviewer's SHOULD on
    // #14609): the same page is always offered as a link, in words that are true either way.
    void tab;
    note("If the Dropbox tab didn't open, open it here:", url, true, 'Open Dropbox to sign in');
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

// checkAgain asks the worker for a pass now (after the person freed space) and reads the status again a few seconds later.
async function checkAgain() {
    note('');
    let r;
    try { r = await post('/api/dropbox/check'); } catch { r = { ok: false }; }
    if (!r.ok) { note("Couldn't check. Try again."); return; }
    setStatus('Checking your Dropbox space…');
    setTimeout(() => { loadDropbox(); }, 4000);
}

// Retention (stage 4b, #14703): "Keep in Dropbox for N days". Turning it on, or changing N, first asks what the next pass would delete and shows
// that count; only Turn on saves it, with the count the person saw. 0 turns it off with no question.
const RETENTION = '/api/dropbox/retention';
let pendingRetention = null; // {days, due, bytes} while the count waits for Turn on or Cancel

function showRetentionConfirm(on) {
    show('settings-dropbox-retention-on', on);
    show('settings-dropbox-retention-cancel', on);
}

function sizeText(bytes) {
    const mb = Number(bytes || 0) / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
}

// retentionDays reads the field: a whole number 0 to 3650, or null (1.9, -1, letters, an empty field and anything else send nothing; UI Reviewer's MUST 2 on #14703).
function retentionDays() {
    const raw = String(($('settings-dropbox-retention-days') || {}).value || '').trim();
    if (!/^[0-9]{1,4}$/.test(raw)) return null;
    const days = Number(raw);
    return days <= 3650 ? days : null;
}

let retentionSeq = 0; // each dry run's number: a late answer for an older one is ignored (UI Reviewer's MUST 1 on #14703)

// dropRetentionPreview forgets a shown count: the field changed, so Turn on would no longer mean what the note says.
function dropRetentionPreview() {
    retentionSeq++;
    if (!pendingRetention) return;
    pendingRetention = null;
    showRetentionConfirm(false);
    note('');
}

const dayWord = (k) => `${k} ${k === 1 ? 'day' : 'days'}`;

export async function saveRetention() {
    note('');
    dropRetentionPreview();
    const days = retentionDays();
    if (days === null) { note('Keep in Dropbox takes a whole number of days, 0 (off) to 3650.'); return; }
    const seq = retentionSeq;
    let res;
    if (days === 0) {
        try { res = await post(RETENTION, 'PUT', JSON.stringify({ days: 0 })); } catch { res = { ok: false, body: {} }; }
        if (!res.ok) { note(String(res.body.error || "Couldn't save. Try again.")); return; }
        note('Retention is off. Nothing more is deleted from Dropbox.');
        await loadDropbox();
        return;
    }
    try { res = await post(RETENTION, 'PUT', JSON.stringify({ days })); } catch { res = { ok: false, body: {} }; }
    if (seq !== retentionSeq || retentionDays() !== days) return; // superseded: the field changed or another count was asked for
    if (!res.ok || !res.body.dry_run || Number(res.body.days) !== days) { note(String(res.body.error || "Couldn't count what would be deleted. Try again.")); return; }
    const due = Number(res.body.due || 0);
    pendingRetention = { days, due, bytes: Number(res.body.bytes || 0), seq };
    const what = due ? `${due} ${due === 1 ? 'file' : 'files'} (${sizeText(res.body.bytes)}) would be deleted from Dropbox now` : 'nothing would be deleted from Dropbox now';
    const later = Number(res.body.held || 0) ? `, and ${res.body.held} more on later passes` : '';
    note(`Keeping files for ${dayWord(days)}: ${what}${later}. Turn on, or Cancel.`);
    showRetentionConfirm(true);
    focusEl('settings-dropbox-retention-on');
}

export async function confirmRetention() {
    const p = pendingRetention;
    // The count must still be for the days the field shows (UI Reviewer's MUST 1): anything else sends nothing.
    if (!p || p.seq !== retentionSeq || retentionDays() !== p.days) { dropRetentionPreview(); return; }
    pendingRetention = null;
    showRetentionConfirm(false);
    focusEl('settings-dropbox-retention-days');
    let res;
    try { res = await post(RETENTION, 'PUT', JSON.stringify({ days: p.days, confirm: true, seen_count: p.due, seen_bytes: p.bytes })); } catch { res = { ok: false, body: {} }; }
    if (!res.ok) { note(String(res.body.error || "Couldn't save. Try again.")); return; }
    note(`Retention is on: files older than ${dayWord(p.days)} are deleted from Dropbox, at most 100 an hour.`);
    await loadDropbox();
}

function cancelRetention() {
    dropRetentionPreview();
    note('Nothing changed.');
    if (lastStatus) renderBackup(lastStatus);
    focusEl('settings-dropbox-retention-days'); // the buttons that had focus are gone (UI Reviewer's SHOULD on #14703)
}

function focusEl(id) {
    const el = $(id);
    if (el && typeof el.focus === 'function') el.focus();
}

function wire() {
    if (wired) return;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { fn(); }); };
    on('settings-dropbox-connect', connectDropbox);
    on('settings-dropbox-disconnect', disconnectDropbox);
    on('settings-dropbox-switch', confirmSwitch);
    on('settings-dropbox-takeover', takeOver);
    on('settings-dropbox-filters-save', saveDropboxFilters);
    on('settings-dropbox-recheck', checkAgain);
    on('settings-dropbox-retention-save', saveRetention);
    on('settings-dropbox-retention-on', confirmRetention);
    on('settings-dropbox-retention-cancel', cancelRetention);
    const field = $('settings-dropbox-retention-days');
    if (field) field.addEventListener('input', dropRetentionPreview); // a changed field takes the shown count and Turn on away
    wired = true;
}
