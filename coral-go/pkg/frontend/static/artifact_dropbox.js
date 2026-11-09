/* An artifact's place in the Dropbox backup (Dropbox stage 6a, #14814), in its Details beside "Private": the Operator on this computer sees whether it
 * is in Dropbox and can remove it (for every Coral that uses the backup), mark it private and remove it (privacy wins), or send a removed artifact
 * again (Security's SHOULD 6). Routes: GET /api/dropbox/artifact/{id}, POST /api/dropbox/remove|private|resend/{id}; all are this computer's alone,
 * so through Coral Hub the read is refused and nothing is drawn. The server decides: the typed confirm when another Coral keeps the file only in
 * Dropbox (the last 4 characters of each), and "Remove anyway" at the rev a file edited in Dropbox has now. Every word is ours, set as text. */
import { serverUrl } from './server_base.js';

const HEX_RE = /^[a-f0-9]{64}$/;
const REMOVE = '/api/dropbox/remove/', PRIVATE = '/api/dropbox/private/', RESEND = '/api/dropbox/resend/', STATE = '/api/dropbox/artifact/';
const url = (prefix, hex, server) => serverUrl(prefix + hex, server);

/** The block, loaded when the Details are shown; taken out again when there is nothing to say (not connected, never backed up, or refused). */
export function dropboxBlock(hex, server, details) {
    const block = document.createElement('section');
    block.className = 'artifact-dropbox';
    if (!HEX_RE.test(String(hex || ''))) return block;
    const title = document.createElement('span'); title.className = 'artifact-private-title'; title.textContent = 'Dropbox backup';
    const state = document.createElement('p'); state.className = 'artifact-private-help';
    const acts = document.createElement('div'); acts.className = 'artifact-dropbox-actions';
    const confirmBox = document.createElement('div'); confirmBox.className = 'artifact-dropbox-confirm'; confirmBox.hidden = true;
    const say = document.createElement('p'); say.className = 'artifact-private-say'; say.setAttribute('role', 'status');
    block.append(title, state, acts, confirmBox, say);
    const button = (text, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.textContent = text; b.addEventListener('click', onClick); return b; };

    const post = async (path, body) => {
        let r, j = {};
        try { r = await fetch(url(path, hex, server), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); } catch { return { status: 0, body: {} }; }
        try { j = await r.json(); } catch { /* no body */ }
        return { status: r.status, body: j || {} };
    };

    // ask shows the confirm for a removal (or Mark private and remove), and what the server needs next: the typed ids, or Remove anyway.
    const ask = (path, typedNeeded = null, anyway = null) => {
        confirmBox.textContent = ''; confirmBox.hidden = false;
        const words = document.createElement('p');
        words.textContent = path === PRIVATE
            ? 'Mark it private and remove it from Dropbox for every Coral that uses this backup. Dropbox may keep it for a while in its deleted files. It stays out of the backup until you send it again.'
            : 'Remove it from Dropbox for every Coral that uses this backup. Dropbox may keep it for a while in its deleted files. It stays out of the backup until you send it again.';
        confirmBox.append(words);
        let typed = null;
        if (typedNeeded) {
            const who = document.createElement('p');
            const ids = (typedNeeded.others || []).map(String);
            const extra = Number(typedNeeded.unknown || 0) ? ` and ${Number(typedNeeded.unknown)} marker${Number(typedNeeded.unknown) === 1 ? '' : 's'} Coral cannot read (type unknown)` : '';
            who.textContent = `Another Coral keeps this file only in Dropbox (…${ids.join(', …')})${extra}. Removing it loses it there. Type the last 4 characters of each, separated by spaces:`;
            typed = document.createElement('input'); typed.type = 'text'; typed.className = 'settings-input'; typed.setAttribute('aria-label', 'The last 4 characters of each other Coral');
            confirmBox.append(who, typed);
        }
        if (anyway) {
            const note = document.createElement('p');
            note.textContent = `${anyway.length} ${anyway.length === 1 ? 'file was' : 'files were'} edited in Dropbox and kept. Remove anyway deletes the version Dropbox has now.`;
            confirmBox.append(note);
        }
        const go = button(anyway ? 'Remove anyway' : (path === PRIVATE ? 'Mark private and remove' : 'Remove from Dropbox'), async () => {
            go.disabled = true; say.textContent = '';
            const body = { confirm: true };
            if (typed) body.typed = typed.value.trim().split(/\s+/).filter(Boolean);
            if (anyway) body.anyway = Object.fromEntries(anyway.map(e => [String(e.path), String(e.rev)]));
            const r = await post(path, body);
            go.disabled = false;
            if (r.status === 409 && r.body.code === 'others_offloaded') { ask(path, r.body, anyway); say.textContent = typed ? 'Those are not the right characters.' : ''; return; }
            if (r.status !== 200) { say.textContent = String(r.body.note || r.body.error || 'Not removed: Coral could not reach Dropbox. Try again.'); return; }
            const edited = Array.isArray(r.body.edited) ? r.body.edited.filter(e => e && e.path && e.rev) : [];
            if (edited.length) { ask(path, null, edited); return; }
            confirmBox.hidden = true;
            say.textContent = r.body.in_progress ? 'Dropbox is still removing it.' : (path === PRIVATE ? 'Marked private and removed from Dropbox.' : 'Removed from Dropbox.');
            await load(true);
        });
        const cancel = button('Cancel', () => { confirmBox.hidden = true; confirmBox.textContent = ''; say.textContent = 'Nothing changed.'; });
        confirmBox.append(go, cancel);
        (typed || go).focus?.();
    };

    let loaded = false;
    const load = async (again = false) => {
        if (loaded && !again) return;
        loaded = true;
        let j = null;
        try { const r = await fetch(url(STATE, hex, server), { cache: 'no-store' }); j = r.ok ? await r.json().catch(() => null) : null; } catch { j = null; }
        if (!j || !j.connected || (!(Number(j.in_dropbox) > 0) && !j.removed)) { details.remove(block); return; } // refused, not connected, or never backed up
        acts.textContent = '';
        if (Number(j.in_dropbox) > 0) {
            const n = Number(j.in_dropbox);
            state.textContent = `In Dropbox (${n} ${n === 1 ? 'file' : 'files'}, with its details).`;
            acts.append(button('Remove from Dropbox…', () => ask(REMOVE)), button('Mark private and remove…', () => ask(PRIVATE)));
        } else {
            state.textContent = 'Removed from Dropbox: it stays out of the backup until you send it again.';
            acts.append(button('Send to Dropbox again', async () => {
                const r = await post(RESEND);
                say.textContent = r.status === 200 ? 'It will be backed up again.' : 'Not changed: Coral could not save it.';
                if (r.status === 200) await load(true);
            }));
        }
    };
    details.onShown(() => load());
    return block;
}
