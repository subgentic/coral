/* The Operator's review of an artifact a team tagged "for review" (#136584, #136588), in the artifact viewer: Approve (the row leaves Needs you, the uploading agent is told) and Request changes (a comment
 * on the whole document, sent to the uploader through the comments' own Send to agent, and the file leaves Needs you: it is the agent's turn, and its next version comes back as a new item). The state is read from the team's artifact list (its tags and,
 * once decided, the time); the buttons show only for a pending one; through Coral Hub the owner has both: the change-request send is the owner's too (#11354). */
import { boardFetch, identityKey, decisionNeedsPerson } from './server_base.js';
import { showToast, announceNotice } from './notifications.js';
import { markHidden } from './visible_marks.js';
import { importOnce } from './import_once.js';
const { createComment, sendComment, uploadCommentImage } = await importOnce('./artifact_comments_api.js'); // lazy, as the viewer's other modules: a failure is retried
const { resultWords } = await importOnce('./artifact_comment_send.js');
const imgs = await importOnce('./artifact_comment_images.js'); // the pictures of a comment: the same tray as the comment box (thumbnails, Mark up, Remove), so a change request can show what to change (#11837)

const HEX = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i;
const rowHex = a => HEX.exec(a.uri || a.digest || a.id || '')?.[1]?.toLowerCase() || '';

/** The team's row for the artifact and the state of its review: pending, changes, approved or reviewed (the old Mark reviewed); null when it was never for review. */
export async function reviewStateOf(team, hex) {
    for (const tag of ['for%20review', 'approved', 'reviewed']) {
        for (let offset = 0; offset <= 10000; offset += 200) {
            const r = await boardFetch(team, `/artifacts?tag=${tag}&limit=200&offset=${offset}`);
            if (!r.ok) return null;
            const data = await r.json(), list = data.artifacts || [];
            const row = list.find(a => rowHex(a) === hex);
            if (row) {
                const tags = row.tags || [];
                if (!['approved', 'for review', 'reviewed'].some(t => tags.includes(t))) break; // the list is asked by tag, and a row without any of them is not a review (never "Reviewed" by default)
                const state = tags.includes('approved') ? 'approved' : tags.includes('for review') ? (tags.includes('changes requested') ? 'changes' : 'pending') : 'reviewed';
                return { row, state, at: row.review?.at || '' };
            }
            if (!data.has_more || !list.length) break;
        }
    }
    return null;
}

const timeWords = at => { const t = Date.parse(at); return Number.isNaN(t) ? '' : new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

async function decide(team, row, decision, reason, note) {
    const r = await boardFetch(team, `/artifacts/${encodeURIComponent(row.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reason ? { decision, reason } : note ? { decision, note } : { decision }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || body.error || `Could not save the review (HTTP ${r.status}).`);
    return body;
}

/** Approving a version settles the ones before it quietly: their 'for review' tag comes off (no review, no message); resolves { settled, failed }. */
async function settleEarlierVersions(m, row) {
    let settled = 0, failed = 0;
    for (const e of m.earlierVersions(row)) {
        try {
            const current = await m.currentTags(e);
            if (current !== null) {
                const r = await boardFetch(e.team, `/artifacts/${encodeURIComponent(e.id)}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: current.filter(t => t !== 'for review') }) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
            }
            settled++;
        } catch { failed++; }
    }
    return { settled, failed };
}

/** Approve a review row of Needs you (or the viewer): it is decided, the Inbox list follows. Resolves the server's answer ({delivered, to, reason}). */
export async function approveRow(team, row, note = '') { // note (#11888): one short comment that goes to the agent in the approval's one notice; the approval is final
    const out = await decide(team, row, 'approve', undefined, String(note || '').replace(/\s+/g, ' ').trim());
    const m = await importOnce('./inbox_reviews.js').catch(() => null);
    if (m) { out.earlier = await settleEarlierVersions(m, row).catch(() => ({ settled: 0, failed: 0 })); m.settleReview(row); m.refreshReviews(true).catch(() => {}); } // the versions before the approved one are settled with it (#11533)
    return out;
}

const shown = name => markHidden(name, { strict: true }); // the uploader's file name is an agent's text: hidden characters are written out wherever it is drawn or spoken (Security's SHOULD, #11552)
const settled = row => importOnce('./inbox_reviews.js').then(m => { m.settleReview(row); return m.refreshReviews(true); }).catch(() => {});
const fromWords = out => (out.delivered && out.asleep ? `${out.to} is asleep: it will see this when it wakes.` : out.delivered ? `${out.to} was told.` : out.reason === 'no_uploader' ? 'No agent is recorded for it, so nobody was told.' : '');

/** Deny a review row (#11552): a final no, the agent is told it was declined, with the reason if there is one. Resolves the server's answer. */
export async function denyRow(team, row, reason) { const out = await decide(team, row, 'deny', reason); settled(row); return out; }
/** Ignore a review row: out of Needs you with no verdict and nobody told; the file stays where it is. Unignore puts it back as it was. */
export async function ignoreRow(team, row) { const out = await decide(team, row, 'ignore'); settled(row); return out; }
export async function unignoreRow(team, row) { const out = await decide(team, row, 'unignore'); importOnce('./inbox_reviews.js').then(m => m.refreshReviews(true)).catch(() => {}); return out; }

/** Save for later (#11641): out of Needs you and its counts, kept in Saved with its decisions; nobody is told. Move to Needs you (unsave) puts it back as it was. */
export async function saveRow(team, row) { const out = await decide(team, row, 'save'); settled(row); return out; }
export async function unsaveRow(team, row) { const out = await decide(team, row, 'unsave'); importOnce('./inbox_reviews.js').then(m => m.refreshReviews(true)).catch(() => {}); return out; }
export function saySaved(team, row) {
    showToast(`Saved for later: ${shown(row.name)}`, false, undefined, { action: { label: 'Undo', onClick: () => unsaveRow(team, row).then(() => announceNotice(`${shown(row.name)} is back in Needs you.`)).catch(e => showToast(e.message)) } });
    announceNotice(`Saved for later: ${shown(row.name)}. Undo is in the notice.`);
}

/** Say what an Ignore did: a toast with Undo (30 s, the notices' rule for a toast with an action) and the same words read out politely. */
export function sayIgnored(team, row) {
    showToast(`Ignored: ${shown(row.name)}`, false, undefined, { action: { label: 'Undo', onClick: () => unignoreRow(team, row).then(() => announceNotice(`${shown(row.name)} is back in Needs you.`)).catch(e => showToast(e.message)) } });
    announceNotice(`Ignored: ${shown(row.name)}. Undo is in the notice.`);
}
export function sayDenied(name, out) { showToast(`Denied ${shown(name)}. ${fromWords(out)}`.trim()); }

/** The Deny dialog: "Deny this?" with an optional reason (500 characters); the agent is told it was declined. Red text, never a red fill. onDone runs after the deny went through. */
export function openDenyDialog(team, row, onDone) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-form inbox-deny-dialog'; dlg.setAttribute('aria-labelledby', 'inbox-deny-title');
    const title = document.createElement('h2'); title.id = 'inbox-deny-title'; title.textContent = `Deny ${shown(row.name)}?`;
    const sub = document.createElement('p'); sub.textContent = 'This is a final no: the agent is told it was denied and should not send it again, in any wording. To ask for a new version, use Changes instead.';
    const label = document.createElement('label'); label.textContent = 'Reason (optional, the agent sees it)';
    const box = document.createElement('textarea'); box.className = 'field'; box.rows = 3; box.maxLength = 500; label.append(box);
    const err = document.createElement('p'); err.className = 'inbox-ask-error'; err.setAttribute('role', 'alert');
    const row2 = document.createElement('div'); row2.className = 'inbox-ask-buttons';
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn inbox-deny-confirm'; go.textContent = 'Deny';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
    row2.append(go, cancel); dlg.append(title, sub, label, err, row2);
    const finish = () => { dlg.close(); dlg.remove(); };
    cancel.addEventListener('click', finish);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    go.addEventListener('click', async () => {
        err.textContent = ''; go.disabled = true;
        try { const out = await denyRow(team, row, box.value.replace(/\s+/g, ' ').trim()); finish(); sayDenied(row.name, out); announceNotice(`Denied ${shown(row.name)}.`); onDone?.(); }
        catch (e) { err.textContent = e.message || 'Not saved.'; go.disabled = false; box.focus(); }
    });
    document.body.append(dlg); dlg.showModal(); box.focus();
    return dlg;
}

/** The Approve with a note dialog (#11888): a file that is almost right is approved with one short comment (500 characters) and not shown again; the agent is told, with the note, and no further review is expected.
 *  onDone runs with the server's answer after the approval went through. */
export function openApproveNoteDialog(team, row, onDone) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-form inbox-approve-note-dialog'; dlg.setAttribute('aria-labelledby', 'inbox-approve-note-title');
    const title = document.createElement('h2'); title.id = 'inbox-approve-note-title'; title.textContent = `Approve ${shown(row.name)} with a note`;
    const sub = document.createElement('p'); sub.textContent = 'It is approved and leaves Needs you for good. The agent is told, with your note, and does not send it back for another review.';
    const label = document.createElement('label'); label.textContent = 'Note (the agent sees it)';
    const box = document.createElement('textarea'); box.className = 'field'; box.rows = 3; box.maxLength = 500; label.append(box);
    const err = document.createElement('p'); err.className = 'inbox-ask-error'; err.setAttribute('role', 'alert');
    const buttons = document.createElement('div'); buttons.className = 'inbox-ask-buttons';
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-primary inbox-approve-note-confirm'; go.textContent = 'Approve';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
    buttons.append(go, cancel); dlg.append(title, sub, label, err, buttons);
    const finish = () => { dlg.close(); dlg.remove(); };
    cancel.addEventListener('click', finish);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    go.addEventListener('click', async () => {
        err.textContent = ''; go.disabled = true;
        try { const out = await approveRow(team, row, box.value); finish(); sayApproved(row.name, out); announceNotice(`Approved ${shown(row.name)}.`); onDone?.(out); }
        catch (e) { err.textContent = e.message || 'Not saved.'; go.disabled = false; box.focus(); }
    });
    document.body.append(dlg); dlg.showModal(); box.focus();
    return dlg;
}

/** Say what an approval did, in a toast. */
export function sayApproved(rawName, out) {
    const name = shown(rawName);
    if (out.earlier && out.earlier.failed) showToast(`Approved ${name}, but ${out.earlier.failed} earlier version${out.earlier.failed === 1 ? '' : 's'} could not be cleared: ${out.earlier.failed === 1 ? 'it' : 'they'} stay${out.earlier.failed === 1 ? 's' : ''} in Needs you.`, true);
    else if (out.delivered && out.asleep) showToast(`Approved. ${out.to} is asleep: it will see this when it wakes.`);
    else if (out.delivered) showToast(`Approved. ${out.to} was told.`);
    else if (out.reason === 'no_uploader') showToast(`Approved ${name}. No agent is recorded for it, so nobody was told.`);
    else showToast(`Approved ${name}.`);
}

/** The review bar of the viewer `d`: attachReview(d, { reload }) returns { open(hex, opts), close() }. */
export function attachReview(d, { reload }) {
    const bar = document.createElement('div');
    bar.className = 'artifact-review'; bar.hidden = true;
    bar.innerHTML = `<span class="artifact-review-state" role="status"></span>
        <button type="button" class="btn btn-primary artifact-review-approve">Approve</button>
        <button type="button" class="btn artifact-review-note">Approve with a note</button>
        <button type="button" class="btn artifact-review-changes" aria-expanded="false">Request changes</button>
        <form class="artifact-review-form" hidden>
            <label for="artifact-review-text">What should change?</label>
            <textarea id="artifact-review-text" rows="3" maxlength="2000" placeholder="This goes to the agent that uploaded it, as a change request in the comments."></textarea>
            <span class="artifact-review-error" role="alert"></span>
            <button type="submit" class="btn btn-primary">Send request</button>
            <button type="button" class="btn artifact-review-cancel">Cancel</button>
        </form>`;
    (d.querySelector('.artifact-viewer-from') || d.querySelector('.artifact-viewer-header')).after(bar); // after who sent it, which sits under the name (#11456)
    const $ = s => bar.querySelector(s);
    const stateEl = $('.artifact-review-state'), approve = $('.artifact-review-approve'), changes = $('.artifact-review-changes'), approveNote = $('.artifact-review-note');
    const form = $('.artifact-review-form'), text = $('#artifact-review-text'), error = $('.artifact-review-error');
    let cur = null, gen = 0, sending = false, done = false;
    const submitBtn = form.querySelector('button[type=submit]');
    const tray = imgs.createImageTray({ upload: (blob, versionOf) => uploadCommentImage(cur.hex, cur.server, blob, versionOf, cur.name) });
    const syncSend = () => { submitBtn.disabled = sending || tray.busy() || tray.failed(); }; // Send waits for a picture still going up, and for a failed one to be removed
    error.before(tray.picker(), tray.node, tray.hint()); tray.attach(form, text); tray.listen(syncSend);
    const show = (s) => {
        cur = s;
        const waiting = !!s && (s.state === 'pending' || s.state === 'changes');
        const pending = waiting && !decisionNeedsPerson(s.server); // a remote of a self-hosted hub: the decision is made on that machine's own dashboard (#11372)
        bar.hidden = !s;
        approve.hidden = changes.hidden = approveNote.hidden = !pending;
        approve.textContent = s && s.state === 'changes' ? 'Approve anyway' : 'Approve'; // changes were asked for: Approve is still the Operator's, and says it approves this version as it is
        if (!pending) form.hidden = true;
        stateEl.textContent = !s ? '' : s.state === 'approved' ? `Approved${s.at ? ' ' + timeWords(s.at) : ''}` : s.state === 'reviewed' ? 'Reviewed' : s.state === 'changes' ? `Changes requested${s.row.produced_by ? `: waiting for a new version from ${shown(s.row.produced_by)}` : ''}. Approving now approves this version as it is.` : waiting && !pending ? 'Waiting for your review. Approve it on that computer\'s own dashboard.' : 'Waiting for your review';
    };
    const openForm = (on) => { form.hidden = !on; changes.setAttribute('aria-expanded', String(on)); if (on) { error.textContent = ''; text.focus(); } };
    changes.addEventListener('click', () => openForm(form.hidden));
    $('.artifact-review-cancel').addEventListener('click', () => { openForm(false); changes.focus(); });
    approve.addEventListener('click', async () => {
        if (!cur) return;
        approve.disabled = true;
        try { const out = await approveRow(cur.team, cur.row); sayApproved(cur.row.name || 'the artifact', out); show({ ...cur, state: 'approved', at: out.review?.at || new Date().toISOString() }); }
        catch (e) { showToast(e.message, true); } finally { approve.disabled = false; }
    });
    approveNote.addEventListener('click', () => {
        if (!cur) return;
        const was = cur;
        openApproveNoteDialog(was.team, was.row, out => show({ ...was, state: 'approved', at: out?.review?.at || new Date().toISOString() }));
    });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (sending) return; // a second tap while the first request is on its way sends nothing
        const body = text.value.trim();
        if (!body || !cur) { error.textContent = 'Say what should change.'; return; }
        const submit = submitBtn; sending = true; submit.disabled = true; text.readOnly = true; error.textContent = '';
        try {
            const who = cur.row.produced_by;
            if (!who) throw new Error('No agent is recorded for this artifact, so there is nobody to ask: use a comment.');
            const c = await createComment(cur.hex, cur.server, { body: `Changes requested: ${body}`, anchor: { whole: true }, board: cur.name, images: tray.hexes() });
            const sent = await sendComment(cur.hex, cur.server, c.id, [who]);
            const r = sent.results[0];
            if (!sent.ok || !r || (r.state !== 'sent' && r.state !== 'already_asked')) throw new Error(r ? `${who}: ${resultWords(r)}. The request is in the comments.` : (sent.error || 'The agent could not be asked.'));
            await decide(cur.team, cur.row, 'changes');
            importOnce('./inbox_reviews.js').then(m => m.refreshReviews(true)).catch(() => {});
            showToast(`Changes requested. ${who} was asked.`);
            text.value = ''; tray.clear(); done = true; openForm(false); show({ ...cur, state: 'changes' }); changes.focus({ preventScroll: true }); reload();
        } catch (err) { error.textContent = err.message; } finally { sending = false; syncSend(); text.readOnly = false; }
    });
    return {
        async open(hex, opts = {}) {
            const g = ++gen; show(null); if (!opts.switched) done = false;
            if (!opts.board) return;
            const team = identityKey(opts.server, opts.board);
            let s = null;
            try { s = await reviewStateOf(team, hex); } catch { s = null; }
            if (g !== gen || !s) return;
            show({ ...s, team, hex, server: opts.server, name: opts.board });
            if (opts.requestChanges && !opts.switched && !done && (s.state === 'pending' || s.state === 'changes')) openForm(true); // not on the reload after a send: the form stays closed
        },
        close() { gen++; show(null); form.hidden = true; tray.clear(); },
    };
}
