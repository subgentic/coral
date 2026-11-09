/* An artifact's place in the Dropbox backup (Dropbox stage 6a, #14814), in the artifact's own view only (the Operator: Dropbox controls are part of
 * the artifact, never of a main screen or a list): the Operator on this computer sees whether it is in Dropbox and can remove it (for every Coral
 * that uses the backup), or send a removed artifact again (Security's SHOULD 6). Deleting the artifact removes its Dropbox copy on its own, 24 hours
 * later (Settings lists those). Routes: GET /api/dropbox/artifact/{id}, POST /api/dropbox/remove|resend/{id}; all are this computer's alone,
 * so through Coral Hub the read is refused and nothing is drawn. The server decides: the typed confirm when another Coral keeps the file only in
 * Dropbox (the last 4 characters of each), and "Remove anyway" at the rev a file edited in Dropbox has now. Every word is ours, set as text. */
import { serverUrl } from './server_base.js';

const HEX_RE = /^[a-f0-9]{64}$/;
const REMOVE = '/api/dropbox/remove/', RESEND = '/api/dropbox/resend/', STATE = '/api/dropbox/artifact/', UNDO = '/api/dropbox/undo/';
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
    confirmBox.setAttribute('role', 'group'); confirmBox.setAttribute('aria-label', 'Confirm removing this file from Dropbox'); // a named group (UI Accessibility's MUST 2)
    const idBase = `dbx-${hex.slice(0, 12)}`;
    let trigger = null; // the button that opened the confirm: the keyboard goes back to it after Cancel or a decision
    const say = document.createElement('p'); say.className = 'artifact-private-say'; say.setAttribute('role', 'status');
    block.append(title, state, acts, confirmBox, say);
    const button = (text, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.textContent = text; b.addEventListener('click', onClick); return b; };

    const post = async (path, body) => {
        let r, j = {};
        try { r = await fetch(url(path, hex, server), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); } catch { return { status: 0, body: {} }; }
        try { j = await r.json(); } catch { /* no body */ }
        return { status: r.status, body: j || {} };
    };

    // ask shows the confirm for a removal, and what the server needs next: the typed ids, or Remove anyway.
    const ask = (path, typedNeeded = null, anyway = null) => {
        if (document.activeElement && acts.contains(document.activeElement)) trigger = document.activeElement;
        confirmBox.textContent = ''; confirmBox.hidden = false;
        confirmBox.setAttribute('aria-label', 'Confirm removing this file from Dropbox'); // its own name again after an Undo confirm (UI Accessibility, round 4)
        const words = document.createElement('p'); words.id = `${idBase}-words`;
        words.textContent = 'Remove it from Dropbox for every Coral that uses this backup. Dropbox may keep it for a while in its deleted files. It stays out of the backup until you send it again.';
        confirmBox.append(words);
        let typed = null;
        if (typedNeeded) {
            const who = document.createElement('p'); who.id = `${idBase}-who`;
            const ids = (typedNeeded.others || []).map(String);
            const extra = Number(typedNeeded.unknown || 0) ? ` and ${Number(typedNeeded.unknown)} marker${Number(typedNeeded.unknown) === 1 ? '' : 's'} Coral cannot read (type unknown)` : '';
            who.textContent = `Another Coral keeps this file only in Dropbox (…${ids.join(', …')})${extra}. Removing it loses it there. Type the last 4 characters of each, separated by spaces:`;
            typed = document.createElement('input'); typed.type = 'text'; typed.className = 'settings-input'; typed.setAttribute('aria-label', 'The last 4 characters of each other Coral');
            typed.setAttribute('aria-describedby', `${idBase}-words ${idBase}-who`); // a screen reader hears what is removed and what to type (MUST 2)
            confirmBox.append(who, typed);
        }
        if (anyway) {
            const note = document.createElement('p');
            note.textContent = `${anyway.length} ${anyway.length === 1 ? 'file was' : 'files were'} edited in Dropbox and kept. Remove anyway deletes the version Dropbox has now.`;
            confirmBox.append(note);
        }
        const go = button(anyway ? 'Remove anyway' : 'Remove from Dropbox', async () => {
            go.disabled = true; say.textContent = '';
            const body = { confirm: true };
            if (typed) body.typed = typed.value.trim().split(/\s+/).filter(Boolean);
            if (anyway) body.anyway = Object.fromEntries(anyway.map(e => [String(e.path), String(e.rev)]));
            const r = await post(path, body);
            go.disabled = false;
            if (r.status === 409 && r.body.code === 'others_offloaded') { ask(path, r.body, anyway); say.textContent = typed ? 'Those are not the right characters. Nothing was removed.' : 'Another Coral keeps this file only in Dropbox: type the characters shown to go on.'; return; }
            if (r.status !== 200) { say.textContent = String(r.body.note || r.body.error || 'Not removed: Coral could not reach Dropbox. Try again.'); return; }
            const edited = Array.isArray(r.body.edited) ? r.body.edited.filter(e => e && e.path && e.rev) : [];
            if (edited.length) { ask(path, null, edited); say.textContent = 'A file was edited in Dropbox and kept: Remove anyway, or Cancel.'; return; }
            confirmBox.hidden = true;
            say.textContent = r.body.in_progress ? 'Dropbox is still removing it.' : 'Removed from Dropbox.';
            await load(true);
            const first = acts.querySelector('button'); (first || trigger)?.focus?.(); // the keyboard goes back to the block's own button
        });
        const cancel = button('Cancel', () => { confirmBox.hidden = true; confirmBox.textContent = ''; say.textContent = 'Nothing changed.'; trigger?.focus?.(); });
        confirmBox.append(go, cancel);
        (typed || cancel).focus?.(); // a destructive confirm starts on Cancel, or on the field the person must type
    };

    // askUndo confirms Undo this edit (Security's condition 3): the edited version goes here; Dropbox keeps the edit in its history.
    const askUndo = () => {
        if (document.activeElement && acts.contains(document.activeElement)) trigger = document.activeElement;
        confirmBox.textContent = ''; confirmBox.hidden = false;
        confirmBox.setAttribute('aria-label', 'Confirm undoing this edit'); // the group is named for what it confirms (UI Accessibility, round 4)
        const words = document.createElement('p'); words.id = `${idBase}-undo`;
        words.textContent = 'This removes the edited version here. The edit stays in your Dropbox history.';
        const go = button('Undo this edit', async () => {
            go.disabled = true;
            const r = await post(UNDO, { confirm: true });
            go.disabled = false;
            confirmBox.hidden = true;
            say.textContent = r.status === 200 ? 'The edit was undone: the version before it is the newest again.' : String(r.body.error || 'Not undone: Coral could not change the file.');
            if (r.status === 200) await load(true);
            (acts.querySelector('button') || trigger)?.focus?.(); // the buttons were drawn again: a live one, never the removed trigger
        });
        const cancel = button('Cancel', () => { confirmBox.hidden = true; confirmBox.textContent = ''; say.textContent = 'Nothing changed.'; trigger?.focus?.(); });
        confirmBox.append(words, go, cancel);
        cancel.focus?.(); // a destructive confirm starts on Cancel
    };

    let loaded = false;
    const load = async (again = false) => {
        if (loaded && !again) return;
        loaded = true;
        let j = null;
        try { const r = await fetch(url(STATE, hex, server), { cache: 'no-store' }); j = r.ok ? await r.json().catch(() => null) : null; } catch { j = null; }
        if (!j || !j.connected || (!(Number(j.in_dropbox) > 0) && !j.removed && !j.undo)) { details.remove(block); return; } // refused, not connected, or never backed up
        acts.textContent = '';
        if (j.undo) acts.append(button('Undo this edit…', askUndo)); // the newest version is an edit made in Dropbox (#14714)
        state.textContent = j.undo ? 'This version is an edit made in Dropbox.' : '';
        if (j.kept_in_dropbox) state.textContent = 'Kept only in Dropbox: opening it fetches it back.'; // stage 6b
        if (Number(j.in_dropbox) > 0) {
            const n = Number(j.in_dropbox);
            state.textContent = j.kept_in_dropbox ? `Kept only in Dropbox (${n} ${n === 1 ? 'file' : 'files'}): opening it fetches it back.` : `In Dropbox (${n} ${n === 1 ? 'file' : 'files'}, with its details).`;
            acts.append(button('Remove from Dropbox…', () => ask(REMOVE)));
        } else if (j.removed) {
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
