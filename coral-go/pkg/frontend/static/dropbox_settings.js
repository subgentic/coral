/* The Dropbox backup block of Settings > Storage and cleanup (#14609, Dropbox stage 3b; design v33 §4, §4b and §11). It reads GET /api/dropbox/status
   (never a token) and offers one next step for each state: Connect, Reconnect, Disconnect, Switch to the new account, Take over. Connect opens Dropbox's
   own page in a new tab; Coral then waits for the person's Allow by reading the status again. Every server text is put in with textContent. */

import { loadStyles } from './lazy_styles.js';

await loadStyles('dropbox.css'); // the block's own sheet, not at start (page_weight)
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
    renderEdits(ed.items || []);
    renderAutoSync(st.autosync);
    renderOffload(st.offload, keepControls);
    if (keepControls) return;
    const chosen = new Set((st.filters && st.filters.types) || []);
    if (box) for (const input of box.querySelectorAll('input[type=checkbox]')) input.checked = chosen.has(input.value);
    const age = $('settings-dropbox-age');
    if (age) age.value = String((st.filters && st.filters.max_age_days) || 0);
    const ret = $('settings-dropbox-keep-for');
    if (ret && !pendingRetention) ret.value = String(keep);
}

// Free up space (stage 6b, #14845): keep files older than N days only in Dropbox. Turning it on shows the dry run's count and asks for both
// sentences (the risk and the warning) before Turn on; 0 turns it off, and the files kept only in Dropbox come back over the next passes.
let offloadSeen = null; // the dry run Turn on confirms: {days, count, bytes}
function renderOffload(o, keepControls) {
    const kept = $('settings-dropbox-offload-kept'), field = $('settings-dropbox-offload-for');
    const days = o ? Number(o.days || 0) : 0, n = o ? Number(o.kept || 0) : 0;
    if (kept) {
        kept.textContent = n ? `${n} ${n === 1 ? 'file is' : 'files are'} (${sizeText(Number(o.kept_bytes || 0))}) kept only in Dropbox${days ? '' : ': they are coming back to this computer'}.` : (days ? `Files older than ${days} days are kept only in Dropbox.` : '');
    }
    if (field && !keepControls && !offloadSeen) field.value = String(days);
}

function offloadConfirm(show) {
    const box = $('settings-dropbox-offload-confirm');
    if (!box) return;
    box.textContent = '';
    box.hidden = !show;
}

export async function saveOffload() {
    const field = $('settings-dropbox-offload-for');
    const days = Number(field && field.value);
    if (!Number.isInteger(days) || days < 0 || days > 3650 || (days > 0 && days < 30)) { note('Free up space is 0 (off) or 30 to 3650 days.'); return; }
    offloadConfirm(false);
    offloadSeen = null;
    let res;
    try { res = await post('/api/dropbox/offload', 'PUT', JSON.stringify({ days })); } catch { res = { ok: false, body: {} }; }
    if (!res.ok) { note(String(res.body.error || "Couldn't save Free up space.")); return; }
    if (!days) { note('Free up space is off. Files kept only in Dropbox come back to this computer over the next passes.'); return; }
    offloadSeen = { days, count: Number(res.body.count || 0), bytes: Number(res.body.bytes || 0) };
    const box = $('settings-dropbox-offload-confirm');
    if (!box) return;
    box.hidden = false;
    const p = document.createElement('p'); p.id = 'settings-dropbox-offload-count';
    p.textContent = `The next pass may free about ${offloadSeen.count} ${offloadSeen.count === 1 ? 'file' : 'files'} (${sizeText(offloadSeen.bytes)}) older than ${days} days.`;
    const tick = (id, text) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.id = id; l.append(c, document.createTextNode(' ' + text)); return { l, c }; };
    const risk = tick('settings-dropbox-offload-risk', String(res.body.risk || ''));
    const warn = tick('settings-dropbox-offload-warning', String(res.body.warning || ''));
    const on = document.createElement('button'); on.type = 'button'; on.className = 'btn btn-small'; on.textContent = 'Turn on'; on.disabled = true;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-small'; cancel.textContent = 'Cancel';
    const sync = () => { on.disabled = !(risk.c.checked && warn.c.checked); };
    risk.c.addEventListener('change', sync); warn.c.addEventListener('change', sync);
    if (field) field.addEventListener('input', () => { offloadSeen = null; offloadConfirm(false); }, { once: true }); // a changed field takes the count away
    on.addEventListener('click', async () => {
        const seen = offloadSeen;
        if (!seen || Number(field && field.value) !== seen.days) { offloadConfirm(false); return; }
        let r2;
        try { r2 = await post('/api/dropbox/offload', 'PUT', JSON.stringify({ days: seen.days, confirm: true, risk_ok: risk.c.checked, warning_ok: warn.c.checked, seen_count: seen.count, seen_bytes: seen.bytes })); } catch { r2 = { ok: false, body: {} }; }
        offloadConfirm(false);
        offloadSeen = null;
        if (r2.status === 409 && r2.body.code === 'changed') { note(`More files would be freed now (${Number(r2.body.count || 0)}). Press Save to see the new count, then confirm again.`); focusEl('settings-dropbox-offload-for'); return; }
        note(r2.ok ? `Free up space is on: files older than ${seen.days} days are kept only in Dropbox after the next pass.` : String(r2.body.error || "Couldn't turn Free up space on."));
        focusEl('settings-dropbox-offload-for');
    });
    cancel.addEventListener('click', () => { offloadConfirm(false); offloadSeen = null; note('Nothing changed.'); focusEl('settings-dropbox-offload-for'); });
    box.append(p, risk.l, warn.l, on, cancel);
    cancel.focus?.();
}

// renderAutoSync shows the auto-sync switch (#14714, the Operator: edits made in Dropbox become new versions on their own) and why it is paused, with
// Resume. Edits it holds (a changed type, a big size jump, the switch off or paused) are the list below, with their two decisions.
function renderAutoSync(a) {
    const box = $('settings-dropbox-autosync'), resume = $('settings-dropbox-autosync-resume'), why = $('settings-dropbox-autosync-note');
    if (!box) return;
    const on = !a || a.on !== false, paused = a && a.paused ? String(a.paused) : '';
    box.checked = on;
    if (resume) resume.hidden = !(on && paused);
    if (!why) return;
    why.textContent = !on ? 'Edits made in Dropbox wait here for you to decide.'
        : paused === 'breaker' ? 'Edits from Dropbox are paused: too many arrived in an hour. They wait here until you Resume.'
        : paused === 'signin' ? 'Edits from Dropbox are paused after a change of sign-in. They wait here until you Resume.'
        : 'An edited file becomes its next version, marked as edited in Dropbox. A file whose type changed, or that grew very large, waits here for you.';
}

export async function setAutoSync(on) {
    let res;
    try { res = await post('/api/dropbox/autosync', 'PUT', JSON.stringify({ on: !!on })); } catch { res = { ok: false, body: {} }; }
    if (!res.ok) { note('Not changed: Coral could not save it.'); }
    renderAutoSync(res.ok ? res.body : lastStatus && lastStatus.autosync);
}

// renderEdits draws the edits made in Dropbox that wait for the Operator (stage 5a, #14714): Coral's own name for the file, the edit's size and
// type, a note that Coral has not shown what changed, the file in Dropbox's own web view (a new tab, noopener noreferrer, built by the server from
// its own path), and the two decisions. All text is textContent.
function renderEdits(items) {
    const list = $('settings-dropbox-edits');
    if (!list) return;
    list.textContent = '';
    list.hidden = !items.length;
    for (const it of items) {
        const li = document.createElement('li');
        li.className = 'settings-dropbox-edit';
        const head = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = String(it.name || 'A file');
        head.append(name, document.createTextNode(` was edited in Dropbox (${sizeText(it.size)}, ${String(it.media_type || 'unknown type')}).`));
        const why = document.createElement('div');
        why.className = 'settings-hint';
        why.append(document.createTextNode('Coral has not shown you what changed. '));
        const url = String(it.dropbox_url || '');
        if (url.startsWith('https://www.dropbox.com/')) {
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = 'Open it in Dropbox to look first';
            why.append(a, document.createTextNode('.'));
        }
        const acts = document.createElement('div');
        acts.className = 'dropbox-inline';
        const doc = String(it.doc_id || '');
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'btn btn-small';
        use.textContent = `Use it as version ${Number(it.next_version) || 2}`;
        use.addEventListener('click', () => decideEdit(doc, 'promote', String(it.name || 'the file')));
        const keep = document.createElement('button');
        keep.type = 'button'; keep.className = 'btn btn-small';
        keep.textContent = 'Keep it separate';
        keep.addEventListener('click', () => decideEdit(doc, 'separate', String(it.name || 'the file')));
        acts.append(use, keep);
        li.append(head, why, acts);
        list.append(li);
    }
}

// decideEdit sends the Operator's decision; a second one (another click, the other button) is refused by the server and said so.
export async function decideEdit(doc, action, name) {
    if (!/^[0-9a-f]{32}$/.test(doc) || (action !== 'promote' && action !== 'separate')) return;
    let res;
    try { res = await post(`/api/dropbox/edits/${doc}/${action}`); } catch { res = { ok: false, status: 0, body: {} }; }
    if (res.status === 409) note(`${name}: this edit was already decided.`);
    else if (!res.ok) { note(String(res.body.error || "Couldn't record that. Try again.")); return; }
    else if (action === 'promote') note(`${name}: the edit is version ${Number(res.body.version) || ''} now.`);
    else note(`${name}: the edit is kept as its own file.`);
    await loadDropbox();
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
    for (const id of ['settings-dropbox-connect', 'settings-dropbox-disconnect', 'settings-dropbox-switch', 'settings-dropbox-takeover', 'settings-dropbox-recheck', 'settings-dropbox-delete']) show(id, false);
    pendingRetention = null;
    retentionSeq++;
    showRetentionConfirm(false);
    const del = $('settings-dropbox-delete-confirm');
    if (del) { del.hidden = true; del.textContent = ''; }
    renderBackup(null);
    const counts = $('settings-dropbox-counts');
    if (counts) counts.textContent = '';
    show('settings-dropbox-delete-rule', false);
    const rm = $('settings-dropbox-removals');
    if (rm) { rm.hidden = true; rm.textContent = ''; }
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
        show('settings-dropbox-delete', true);
        loadRemovals();
        return;
    }
    if (st.connected) {
        setStatus(`Connected to Dropbox (${st.account_id || 'account'}).`);
        show('settings-dropbox-disconnect', true);
        show('settings-dropbox-delete', true);
        loadRemovals();
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

const DISCONNECT = '/api/dropbox/disconnect';

export async function disconnectDropbox() {
    note('');
    let res;
    try { res = await post(DISCONNECT); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (!res.ok) { note("Couldn't disconnect. Try again."); return; }
    await loadDropbox();
    if (res.body.revoked === false) {
        note('Disconnected here, but Coral could not end its sign-in at Dropbox. To finish, remove Coral under Connected apps in your Dropbox settings.');
    }
}

// Removals after a delete here (#14814, the Operator's answer 3): a file deleted in Coral leaves Dropbox 24 hours later, by the backup worker. Settings
// lists what waits, what is held because many files were deleted at once, and what Coral would not remove on its own (another Coral keeps it only in
// Dropbox, its markers could not be read, or it was edited in Dropbox), each with the Operator's own control. Every word is set as text.
const REMOVALS = '/api/dropbox/removals';
let removalsSeq = 0;

export async function loadRemovals() {
    const box = $('settings-dropbox-removals');
    if (!box) return;
    show('settings-dropbox-delete-rule', true);
    const seq = ++removalsSeq;
    let j = null;
    try { const r = await fetch(REMOVALS, { cache: 'no-store' }); j = r.ok ? await r.json() : null; } catch { j = null; }
    if (seq !== removalsSeq) return; // a newer read is on its way
    renderRemovals(j && Array.isArray(j.removals) ? j.removals : []);
}

const rmButton = (text, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.textContent = text; b.addEventListener('click', onClick); return b; };
const rmLine = (text, cls = 'settings-hint') => { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; };
const rmName = r => String(r.name || 'A file');

function renderRemovals(rows) {
    const box = $('settings-dropbox-removals');
    if (!box) return;
    box.textContent = '';
    const waiting = rows.filter(r => r.state === 'waiting'), held = rows.filter(r => r.state === 'held');
    const asked = rows.filter(r => r.state === 'kept' || r.state === 'edited');
    box.hidden = !rows.length;
    if (waiting.length) {
        const first = waiting.map(r => Date.parse(r.due_at)).filter(t => !Number.isNaN(t)).sort((a, b) => a - b)[0];
        const when = first ? new Date(first).toLocaleString() : 'later';
        const acts = document.createElement('div'); acts.className = 'dropbox-inline';
        acts.append(rmButton('Keep them in Dropbox', () => cancelRemovals({ state: 'waiting' }, 'They stay in Dropbox.')));
        box.append(rmLine(`${waiting.length} deleted ${waiting.length === 1 ? 'file' : 'files'} will be removed from Dropbox from ${when}.`), acts);
    }
    if (held.length) {
        const acts = document.createElement('div'); acts.className = 'dropbox-inline';
        acts.append(rmButton('Remove them from Dropbox', confirmHeld), rmButton('Keep them in Dropbox', () => cancelRemovals({ state: 'held' }, 'They stay in Dropbox.')));
        box.append(rmLine(`${held.length} deleted ${held.length === 1 ? 'file waits' : 'files wait'} for your OK before leaving Dropbox: many files were deleted at once.`), acts);
    }
    if (asked.length) {
        const list = document.createElement('ul'); list.className = 'settings-dropbox-edits';
        for (const r of asked) list.append(askedRemoval(r));
        box.append(rmLine('Deleted here, but Coral did not remove these from Dropbox on its own:'), list);
    }
}

// askedRemoval is one file Coral would not remove on its own, with the Operator's control: the typed last 4 of each other Coral, Try again, or
// Remove anyway at the rev Dropbox showed; and Keep it in Dropbox.
function askedRemoval(r) {
    const li = document.createElement('li'); li.className = 'settings-dropbox-edit';
    const idBase = `settings-dropbox-rm-${String(r.digest || '').slice(0, 12)}`;
    const name = document.createElement('strong'); name.textContent = rmName(r);
    const why = document.createElement('p'); why.className = 'settings-hint'; why.id = `${idBase}-why`;
    const acts = document.createElement('div'); acts.className = 'dropbox-inline';
    const body = { confirm: true };
    let typed = null;
    if (r.state === 'edited') {
        why.textContent = 'It was edited in Dropbox after Coral backed it up. Remove anyway deletes the version Dropbox has now.';
        body.anyway = Object.fromEntries((Array.isArray(r.edited) ? r.edited : []).filter(e => e && e.path && e.rev).map(e => [String(e.path), String(e.rev)]));
    } else if (r.reason === 'markers_unreadable') {
        why.textContent = 'Coral could not check whether another Coral keeps it only in Dropbox, so it was left there.';
    } else {
        const ids = (Array.isArray(r.others) ? r.others : []).map(String);
        const unknown = Number(r.unknown || 0);
        why.textContent = `Another Coral keeps it only in Dropbox (…${ids.join(', …')})${unknown ? ` and ${unknown} marker${unknown === 1 ? '' : 's'} Coral cannot read (type unknown)` : ''}. Removing it loses it there. Type the last 4 characters of each, separated by spaces:`;
        typed = document.createElement('input'); typed.type = 'text'; typed.className = 'settings-input';
        typed.setAttribute('aria-label', `The last 4 characters of each other Coral, to remove ${rmName(r)}`);
        typed.setAttribute('aria-describedby', why.id);
    }
    const go = rmButton(r.state === 'edited' ? 'Remove anyway' : (typed ? 'Remove from Dropbox' : 'Try again'), async () => {
        go.disabled = true;
        if (typed) body.typed = typed.value.trim().split(/\s+/).filter(Boolean);
        let res;
        try { res = await post(`/api/dropbox/remove/${encodeURIComponent(String(r.digest || ''))}`, 'POST', JSON.stringify(body)); } catch { res = { ok: false, status: 0, body: {} }; }
        go.disabled = false;
        if (res.ok && !(Array.isArray(res.body.edited) && res.body.edited.length)) { note(res.body.in_progress ? 'Dropbox is still removing it.' : `${rmName(r)} was removed from Dropbox.`); loadRemovals(); return; }
        if (res.ok) { note('It was edited in Dropbox again. Nothing more was removed.'); loadRemovals(); return; }
        note(res.body.code === 'others_offloaded' ? 'Those are not the right characters. Nothing was removed.' : String(res.body.error || 'Not removed: Coral could not reach Dropbox. Try again.'));
    });
    const keep = rmButton('Keep it in Dropbox', () => cancelRemovals({ digest: String(r.digest || '') }, `${rmName(r)} stays in Dropbox.`));
    acts.append(...(typed ? [typed] : []), go, keep);
    li.append(name, why, acts);
    return li;
}

async function cancelRemovals(what, said) {
    let res;
    try { res = await post(`${REMOVALS}/cancel`, 'POST', JSON.stringify(what)); } catch { res = { ok: false, body: {} }; }
    note(res.ok ? said : 'Not changed: Coral could not save it.');
    loadRemovals();
}

async function confirmHeld() {
    let res;
    try { res = await post(`${REMOVALS}/confirm`, 'POST', JSON.stringify({ confirm: true })); } catch { res = { ok: false, body: {} }; }
    note(res.ok ? 'They will be removed from Dropbox once their 24 hours have passed.' : 'Not changed: Coral could not save it.');
    loadRemovals();
}

// Disconnect and delete the backup (stage 6a, #14814): the server says what the confirm needs (the files not from this computer and the other
// Corals keeping files only in Dropbox); the person types delete, that count and each other Coral's last 4; the sign-in goes only when the delete
// finished.
export async function deleteBackupStart() {
    note('');
    let res;
    try { res = await post(DISCONNECT, 'POST', JSON.stringify({ delete_backup: true })); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (res.status === 409 && res.body.code === 'confirm_delete_backup') { showDeleteConfirm(res.body); return; }
    note(String(res.body.error || "Couldn't check the backup. Try again."));
}

function showDeleteConfirm(info) {
    const box = $('settings-dropbox-delete-confirm');
    if (!box) return;
    box.textContent = '';
    box.hidden = false;
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Delete the Dropbox backup'); // a named group (UI Accessibility's MUST 2)
    const files = Number(info.files || 0), foreign = Number(info.foreign || 0);
    const others = Array.isArray(info.others) ? info.others.map(String) : [];
    const unknown = Number(info.unknown || 0);
    const need = ['delete', ...(foreign ? [String(foreign)] : []), ...others, ...(unknown ? ['unknown'] : [])];
    const p = document.createElement('p');
    p.id = 'settings-dropbox-delete-words';
    p.textContent = `This deletes the Dropbox backup (${files} ${files === 1 ? 'file' : 'files'}) for every Coral that uses it, then disconnects.`
        + (foreign ? ` ${foreign} of them did not come from this computer.` : '')
        + (others.length ? ` Other Corals keep files only in Dropbox (…${others.join(', …')}): they lose them.` : '')
        + ` Dropbox may keep deleted files for a while. To go on, type: ${need.join(' ')}`;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'settings-input'; input.id = 'settings-dropbox-delete-typed';
    input.setAttribute('aria-label', 'Type the words shown to delete the backup');
    input.setAttribute('aria-describedby', 'settings-dropbox-delete-words'); // a screen reader hears what is deleted and the words to type
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-small'; go.textContent = 'Delete the backup and disconnect';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-small'; cancel.textContent = 'Cancel';
    go.addEventListener('click', () => deleteBackupConfirm(input.value));
    cancel.addEventListener('click', () => { box.hidden = true; box.textContent = ''; note('Nothing changed.'); $('settings-dropbox-delete')?.focus?.(); });
    box.append(p, input, go, cancel);
    input.focus?.(); // the words must be typed: the field, labelled, has the focus
}

export async function deleteBackupConfirm(typedText) {
    const typed = String(typedText || '').trim().split(/\s+/).filter(Boolean);
    let res;
    try { res = await post(DISCONNECT, 'POST', JSON.stringify({ delete_backup: true, typed })); } catch { note("Couldn't reach Coral. Try again."); return; }
    if (res.status === 409 && res.body.code === 'confirm_delete_backup') { showDeleteConfirm(res.body); note('Those are not the words shown. Nothing was deleted.'); return; }
    if (res.status === 202) { note('Dropbox is still deleting the backup. You are still connected; press it again in a while.'); return; }
    if (!res.ok) { note(String(res.body.error || "Couldn't delete the backup. You are still connected.")); return; }
    const box = $('settings-dropbox-delete-confirm');
    if (box) { box.hidden = true; box.textContent = ''; }
    await loadDropbox();
    note('The Dropbox backup was deleted and Coral disconnected.');
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
    const raw = String(($('settings-dropbox-keep-for') || {}).value || '').trim();
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
    focusEl('settings-dropbox-keep-for');
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
    focusEl('settings-dropbox-keep-for'); // the buttons that had focus are gone (UI Reviewer's SHOULD on #14703)
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
    on('settings-dropbox-delete', deleteBackupStart);
    on('settings-dropbox-switch', confirmSwitch);
    on('settings-dropbox-takeover', takeOver);
    on('settings-dropbox-filters-save', saveDropboxFilters);
    on('settings-dropbox-recheck', checkAgain);
    on('settings-dropbox-retention-save', saveRetention);
    on('settings-dropbox-retention-on', confirmRetention);
    on('settings-dropbox-retention-cancel', cancelRetention);
    const sync = $('settings-dropbox-autosync');
    if (sync) sync.addEventListener('change', () => setAutoSync(sync.checked));
    on('settings-dropbox-autosync-resume', () => setAutoSync(true));
    on('settings-dropbox-offload-save', saveOffload);
    const field = $('settings-dropbox-keep-for');
    if (field) field.addEventListener('input', dropRetentionPreview); // a changed field takes the shown count and Turn on away
    wired = true;
}
