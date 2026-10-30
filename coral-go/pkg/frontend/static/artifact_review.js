/* The Operator's review of an artifact a team tagged "for review" (#136584, #136588), in the artifact viewer: Approve (the row leaves Needs you, the uploading agent is told) and Request changes (a comment
 * on the whole document, sent to the uploader through the comments' own Send to agent, and the row stays in Needs you as "changes requested"). The state is read from the team's artifact list (its tags and,
 * once decided, the time); the buttons show only for a pending one; through Coral Hub the owner has both: the change-request send is the owner's too (#11354). */
import { boardFetch, identityKey } from './server_base.js';
import { showToast } from './utils.js';
import { importOnce } from './import_once.js';
const { createComment, sendComment } = await importOnce('./artifact_comments_api.js'); // lazy, as the viewer's other modules: a failure is retried
const { resultWords } = await importOnce('./artifact_comment_send.js');

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

async function decide(team, row, decision) {
    const r = await boardFetch(team, `/artifacts/${encodeURIComponent(row.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || body.error || `Could not save the review (HTTP ${r.status}).`);
    return body;
}

/** Approve a review row of Needs you (or the viewer): it is decided, the Inbox list follows. Resolves the server's answer ({delivered, to, reason}). */
export async function approveRow(team, row) {
    const out = await decide(team, row, 'approve');
    importOnce('./inbox_reviews.js').then(m => { m.settleReview(row); return m.refreshReviews(true); }).catch(() => {});
    return out;
}

/** Say what an approval did, in a toast. */
export function sayApproved(name, out) {
    if (out.delivered && out.asleep) showToast(`Approved. ${out.to} is asleep: it will see this when it wakes.`);
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
        <button type="button" class="btn artifact-review-changes" aria-expanded="false">Request changes</button>
        <form class="artifact-review-form" hidden>
            <label for="artifact-review-text">What should change?</label>
            <textarea id="artifact-review-text" rows="3" maxlength="2000" placeholder="This goes to the agent that uploaded it, as a change request in the comments."></textarea>
            <span class="artifact-review-error" role="alert"></span>
            <button type="submit" class="btn btn-primary">Send request</button>
            <button type="button" class="btn artifact-review-cancel">Cancel</button>
        </form>`;
    d.querySelector('.artifact-viewer-header').after(bar);
    const $ = s => bar.querySelector(s);
    const stateEl = $('.artifact-review-state'), approve = $('.artifact-review-approve'), changes = $('.artifact-review-changes');
    const form = $('.artifact-review-form'), text = $('#artifact-review-text'), error = $('.artifact-review-error');
    let cur = null, gen = 0, sending = false, done = false;
    const show = (s) => {
        cur = s;
        const pending = !!s && (s.state === 'pending' || s.state === 'changes');
        bar.hidden = !s;
        approve.hidden = changes.hidden = !pending;
        if (!pending) form.hidden = true;
        stateEl.textContent = !s ? '' : s.state === 'approved' ? `Approved${s.at ? ' ' + timeWords(s.at) : ''}` : s.state === 'reviewed' ? 'Reviewed' : s.state === 'changes' ? 'Changes requested' : 'Waiting for your review';
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
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (sending) return; // a second tap while the first request is on its way sends nothing
        const body = text.value.trim();
        if (!body || !cur) { error.textContent = 'Say what should change.'; return; }
        const submit = form.querySelector('button[type=submit]'); sending = true; submit.disabled = true; text.readOnly = true; error.textContent = '';
        try {
            const who = cur.row.produced_by;
            if (!who) throw new Error('No agent is recorded for this artifact, so there is nobody to ask: use a comment.');
            const c = await createComment(cur.hex, cur.server, { body: `Changes requested: ${body}`, anchor: { whole: true }, board: cur.name });
            const sent = await sendComment(cur.hex, cur.server, c.id, [who]);
            const r = sent.results[0];
            if (!sent.ok || !r || (r.state !== 'sent' && r.state !== 'already_asked')) throw new Error(r ? `${who}: ${resultWords(r)}. The request is in the comments.` : (sent.error || 'The agent could not be asked.'));
            await decide(cur.team, cur.row, 'changes');
            importOnce('./inbox_reviews.js').then(m => m.refreshReviews(true)).catch(() => {});
            showToast(`Changes requested. ${who} was asked.`);
            text.value = ''; done = true; openForm(false); show({ ...cur, state: 'changes' }); changes.focus({ preventScroll: true }); reload();
        } catch (err) { error.textContent = err.message; } finally { sending = false; submit.disabled = false; text.readOnly = false; }
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
        close() { gen++; show(null); form.hidden = true; },
    };
}
