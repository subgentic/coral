// The review size guard's warning on a task that is in review (#21027): shown only when the team's setting is on and the diff is over a limit. A warning, never a block. The verdict is GET
// /api/board/{project}/tasks/{id}/review-size: {applies, over, lines, files, skipped_lines, skipped_files, limit_lines, limit_files, over_limit, send_back_note, split_ask}; no setting, no diff (404) or a
// refusal draw nothing. With the team's Over the limit set to send_back or split (#21059) the banner carries one button: Send back to author (an editable note, then POST .../review-size/send-back) or
// Split into follow-ups (a confirmation, then POST .../review-size/split). Nothing happens until it is pressed; the server decides who may.
import { boardFetch, pathId } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
import { showToast } from './notifications.js';
import { showConfirmModal } from './confirm_dialog.js';

const n = v => Number(v || 0).toLocaleString('en-US');
const plural = (count, one, many) => `${n(count)} ${Number(count) === 1 ? one : many}`;

/** The sentences of the banner, from the verdict's own numbers. */
export function reviewSizeWords(v) {
    const limits = [v.limit_lines > 0 && plural(v.limit_lines, 'line', 'lines'), v.limit_files > 0 && plural(v.limit_files, 'file', 'files')].filter(Boolean).join(' or ');
    const skipped = v.skipped_files > 0 || v.skipped_lines > 0 ? ` ${plural(v.skipped_lines, 'line', 'lines')} in ${plural(v.skipped_files, 'skipped path', 'skipped paths')} ${v.skipped_lines === 1 && v.skipped_files === 1 ? 'is' : 'are'} not counted.` : '';
    return { lead: 'Large change.', text: ` ${plural(v.lines, 'line', 'lines')} in ${plural(v.files, 'file', 'files')}; your team's limit is ${limits}.${skipped}`, note: 'This is a warning only. You can still review and approve it.' };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const post = (project, task, path, body) => boardFetch(project, `/tasks/${pathId(task.id)}/review-size/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const refusal = async r => { const j = await r.json().catch(() => ({})); return typeof j.error === 'string' && j.error ? j.error : `Coral could not do that (${r.status}).`; };
/** The task's author, the one a send-back returns it to: the review is the Orchestrator's, the work is the author's. */
const authorOf = task => (task.workflow && task.workflow.original_author) || task.assigned_to || 'the author';

/** Send back to author: the note is filled in with the limit and can be edited; Send back posts it and the task goes back to its author. */
function openSendBack(v, ctx) {
    const author = authorOf(ctx.task);
    const dlg = el('dialog', 'dlg-confirm review-size-dialog'); dlg.setAttribute('aria-labelledby', 'review-size-send-title');
    const form = el('form'); form.noValidate = true;
    const title = el('h3', null, `Send back to ${author}?`); title.id = 'review-size-send-title';
    const note = el('textarea'); note.rows = 5; note.maxLength = 4096; note.value = v.send_back_note || ''; note.setAttribute('aria-label', 'Note to the author');
    const err = el('p', 'review-size-error'); err.setAttribute('role', 'alert');
    const send = el('button', 'btn btn-primary', 'Send back'); send.type = 'submit';
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => dlg.close());
    const actions = el('div', 'modal-actions'); actions.append(cancel, send);
    form.append(title, el('p', 'review-size-lead', 'The author gets this note and the task goes back to them. Edit it if you like.'), note, err, actions);
    dlg.append(form); document.body.append(dlg);
    form.addEventListener('submit', async e => {
        e.preventDefault(); err.textContent = ''; send.disabled = true;
        try {
            const r = await post(ctx.project, ctx.task, 'send-back', { note: note.value });
            if (!r.ok) throw new Error(await refusal(r));
            dlg.close(); showToast(`Sent back to ${author}`); ctx.onDone?.();
        } catch (ex) { err.textContent = `Not sent back: ${ex.message}`; send.disabled = false; }
    });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal(); note.focus();
}

/** Split into follow-ups: says what the Orchestrator will be asked, then asks it. The review stays open. */
function askSplit(v, ctx) {
    showConfirmModal(`Split #${ctx.task.id} into follow-ups?`, `The Orchestrator reads the change and files follow-up tasks, each under the limit. Nothing is approved or rejected until you decide. The Orchestrator is asked: \u201c${v.split_ask || ''}\u201d`, async () => {
        try {
            const r = await post(ctx.project, ctx.task, 'split');
            if (!r.ok) { showToast(`Not asked: ${await refusal(r)}`, true); return; }
            showToast('The Orchestrator is asked to split it'); ctx.onDone?.();
        } catch (ex) { showToast(`Not asked: ${ex.message}`, true); }
    }, null, { label: 'Ask the Orchestrator to split', danger: false });
}

/** The banner node for a verdict, or null when there is nothing to warn about. ctx ({project, task, onDone}) lets the Send back and Split buttons act; without it the banner only warns. */
export function reviewSizeBanner(v, ctx) {
    if (!v || v.applies !== true || v.over !== true) return null;
    const w = reviewSizeWords(v);
    const mode = ctx && (v.over_limit === 'send_back' || v.over_limit === 'split') ? v.over_limit : '';
    const box = document.createElement('div'); box.className = 'notice notice-warn review-size-banner'; box.setAttribute('role', 'status');
    const icon = document.createElement('span'); icon.className = 'material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'warning';
    const body = document.createElement('div');
    const lead = document.createElement('b'); lead.textContent = w.lead;
    const text = document.createTextNode(w.text);
    body.append(lead, text);
    if (mode) {
        body.append(el('div', 'review-size-note', mode === 'send_back' ? 'Your team sends a change this size back to its author.' : 'Your team splits a change this size into follow-up tasks.'));
        const act = el('button', 'btn review-size-action', mode === 'send_back' ? 'Send back to author' : 'Split into follow-ups'); act.type = 'button';
        act.addEventListener('click', () => (mode === 'send_back' ? openSendBack(v, ctx) : askSplit(v, ctx)));
        body.append(act, el('div', 'review-size-note', 'You can still approve it.'));
    } else body.append(el('div', 'review-size-note', w.note));
    box.append(icon, body);
    return box;
}

/** Reads the verdict for a task and puts the banner before the task's facts (the third argument) when the change is over the limit. Never throws: a task with no diff, a refusal or a failed read shows nothing. */
export async function showReviewSize(project, task, anchor, onDone) {
    try {
        const r = await boardFetch(project, `/tasks/${pathId(task.id)}/review-size`);
        if (!r.ok) return;
        const banner = reviewSizeBanner(await r.json(), { project, task, onDone });
        if (!banner || !anchor.isConnected) return;
        await loadStyles('task_review_size.css');
        if (anchor.isConnected && !anchor.parentNode.querySelector(':scope > .review-size-banner')) anchor.before(banner);
    } catch { /* a warning is only extra: the page works without it */ }
}
