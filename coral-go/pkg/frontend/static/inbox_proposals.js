/* What agents asked to add to a team, waiting for the Operator (#11389): the proposals of the teams whose goals or tasks need approval, read from GET /api/proposals and shown as rows of Needs you. Approve makes the
 * goal or task exactly as proposed; Edit and approve changes its words first; Reject says no, with a reason the proposer is told once. Everything the agents wrote is set as text (textContent, a field's value),
 * never as HTML. The Operator's alone: the machine answers a guest or a grantee 403, and then there are no rows. An expired proposal stays in the list, marked, until the Operator dismisses it here. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { loadStyles } from './lazy_styles.js';
const { markHidden } = await importOnce('./visible_marks.js'); // lazy: its failure is retried
const { proposalItems, pendingProposals, onProposalsChanged, refreshProposals, dismissExpired, decide } = await importOnce('./proposals_state.js'); // lazy: its failure is retried
const { el } = await importOnce('./data_table.js');
await loadStyles('inbox_proposals.css');
export { proposalItems, pendingProposals, onProposalsChanged, refreshProposals };

/** What an agent wrote, for a place that shows it as one line: every hidden or reordering character written out as <U+202E> (strict: nothing is left alone), a line break a space. */
export const markedText = t => markHidden(t, { strict: true }).replace(/\s+/g, ' ').trim();
/** The same for a block shown whole (the detail): line breaks and blanks are kept, every hidden or reordering character is written out. */
export const markedBlock = t => markHidden(t, { strict: true });
/** How many hidden or reordering characters the words hold (what markHidden writes out: not a line break or a tab). */
export const hiddenCount = t => (String(t == null ? '' : t).replace(/\r\n/g, '\n').match(/[\p{Cc}\p{Cf}]/gu) || []).filter(c => c !== '\n' && c !== '\t').length;
const kindWord = p => (p.kind === 'goal' ? 'goal' : 'task');

/** What a proposal carries, for the dialog and the row: its words, the instructions and required outputs the assignee will be given (shown in full: the Operator approves what they read), and one line of everything else it sets. */
export function proposalFacts(p) {
    const pay = p.payload && typeof p.payload === 'object' ? p.payload : {};
    if (p.kind === 'goal') return { body: pay.outcome || '', instructions: '', outputs: [], also: pay.done_when ? [`Done when: ${pay.done_when}`] : [] };
    const wf = pay.workflow && typeof pay.workflow === 'object' ? pay.workflow : {};
    const blocked = Array.isArray(pay.blocked_by) ? pay.blocked_by.map(b => (b && typeof b === 'object' ? `#${b.task_id}` : `#${b}`)) : [];
    const also = [pay.assigned_to ? `assigned to ${pay.assigned_to}` : '', pay.priority ? `priority ${pay.priority}` : '', blocked.length ? `blocked by ${blocked.join(', ')}` : '', pay.remind_at ? `a reminder at ${new Date(pay.remind_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '', pay.draft ? 'a draft (not published)' : '', pay.goal_id ? `under goal #${pay.goal_id}` : '', p.goal_proposal_id ? `for the goal waiting as proposal #${p.goal_proposal_id}` : ''].filter(Boolean);
    return { body: pay.body || '', instructions: String(wf.instructions || ''), outputs: Array.isArray(wf.required_outputs) ? wf.required_outputs.map(String) : [], also };
}

/** Whether a proposal carries instructions for the assignee (the row says so). */
export const carriesInstructions = p => { const f = proposalFacts(p); return !!(f.instructions || f.outputs.length); };

/** The line a row says: who proposed what. */
export const proposalSummary = p => `Proposes a ${kindWord(p)}: ${markedText(p.title)}`;

/** The one line a row shows of a proposal's words: the first line of its body, cut (the row's CSS cuts it again at the edge with an ellipsis, so it never wraps). */
export function proposalSnippet(p) {
    const pay = p.payload && typeof p.payload === 'object' ? p.payload : {};
    const first = markedText(String(pay.body || pay.outcome || '').trim().split(/\r?\n/)[0]); // marked first, then cut: a mark is never cut in half
    return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

/** The buttons of a row, one line like a review's: Approve makes it as proposed (the Operator's ruling: the one line they read is what they approve, and 'Carries instructions' is on it when there are some), Edit opens the detail with the words open to change, Reject opens it on the reason. An expired one has Dismiss. A refusal is a toast: the row stays one line. */
export function proposalActions(p) {
    const box = el('div', 'inbox-review-actions inbox-proposal-actions');
    const btn = (label, aria, run) => { const b = el('button', 'btn btn-small', label); b.type = 'button'; b.setAttribute('aria-label', aria); b.addEventListener('click', e => { e.stopPropagation(); run(b); }); return b; };
    if (p.state === 'expired') {
        box.append(el('span', 'inbox-proposal-expired', 'Expired, nothing was made'), btn('Dismiss', `Dismiss the expired ${kindWord(p)} ${markedText(p.title)}`, () => dismissExpired(p)));
        return box;
    }
    if (p.state === 'approving') { box.append(el('span', 'inbox-proposal-expired', 'Being approved…')); return box; } // an Approve has it: nothing to press until it finishes (a stuck one is looked into after five minutes)
    box.append(btn('Approve', `Approve the ${kindWord(p)} ${markedText(p.title)}`, async b => {
            b.disabled = true;
            const res = await decide(p, 'approve');
            if (res.ok) showToast(res.text, false, 4000); else { b.disabled = false; showToast(res.text, true, 6000); }
        }),
        btn('Edit', `Edit and approve the ${kindWord(p)} ${markedText(p.title)}`, () => openProposalDialog(p, 'edit')),
        btn('Reject', `Reject the ${kindWord(p)} ${markedText(p.title)}`, () => openProposalDialog(p, 'reject')));
    return box;
}

/** The dialog of a proposal: its words, who proposed it and for which team, and the three decisions. mode: 'view' | 'edit' | 'reject' (which part is open first). */
export function openProposalDialog(p, mode = 'view') {
    document.getElementById('proposal-dialog')?.remove();
    const facts = proposalFacts(p), pay = p.payload && typeof p.payload === 'object' ? p.payload : {};
    const d = el('dialog', 'modal-content dlg-form proposal-dialog'); d.id = 'proposal-dialog'; d.setAttribute('aria-labelledby', 'proposal-dialog-title');
    const h = el('h2', null, `${kindWord(p) === 'goal' ? 'A goal' : 'A task'} waiting for your approval`); h.id = 'proposal-dialog-title';
    const who = el('p', 'proposal-who', `${markedText(p.proposer)} proposed it for ${p.board_id}.${p.goal_proposal_id ? ' It is for a goal that is also waiting: approve that goal first.' : ''}`);
    const inputs = []; // [field, the raw words]: a field shows the words marked until Edit opens them, then the raw words
    let editing = mode === 'edit';
    const field = (label, value, tall) => { const l = el('label', 'proposal-field'); l.append(el('span', null, label)); const i = el(tall ? 'textarea' : 'input', 'field'); if (tall) i.rows = 4; i.value = editing ? value : markedBlock(value); i.readOnly = !editing; inputs.push([i, value]); l.append(i); return [l, i]; }; // the words are read first: they are changed only after Edit and approve
    const [tl, title] = field('Title', p.title);
    const parts = [tl];
    let second = null, third = null;
    if (p.kind === 'goal') { const [ol, o] = field('Outcome', pay.outcome || '', true); const [dl, dw] = field('Done when', pay.done_when || ''); second = o; third = dw; parts.push(ol, dl); }
    else { const [bl, b] = field('Details', pay.body || '', true); second = b; parts.push(bl); }
    const why = field('Reason (the agent is told)', '', true), reason = why[1]; reason.readOnly = false; inputs.pop(); // the reason is the Operator's own
    const reasonRow = why[0]; reasonRow.hidden = mode !== 'reject';
    const hidden = el('p', 'proposal-hidden'); hidden.setAttribute('role', 'status'); hidden.hidden = true;
    const sayHidden = () => { const n = inputs.reduce((sum, [, raw]) => sum + hiddenCount(raw), 0); hidden.hidden = n === 0; hidden.textContent = n ? `These words hold ${n} hidden character${n === 1 ? '' : 's'}.` : ''; };
    const status = el('p', 'proposal-status'); status.setAttribute('role', 'alert');
    const row = el('div', 'modal-actions proposal-buttons');
    const close = el('button', 'btn', 'Close'); close.type = 'button'; close.addEventListener('click', () => d.close());
    const approve = el('button', 'btn btn-primary', mode === 'edit' ? 'Approve with these words' : 'Approve'); approve.type = 'button';
    const editOpen = el('button', 'btn', 'Edit and approve'); editOpen.type = 'button'; editOpen.hidden = mode !== 'view';
    const rejectOpen = el('button', 'btn btn-danger', mode === 'reject' ? 'Reject' : 'Reject…'); rejectOpen.type = 'button';
    const edits = () => {
        const e = {};
        if (!editing) return e; // a field that shows marked words is not an edit
        if (title.value.trim() !== p.title) e.title = title.value.trim();
        if (p.kind === 'goal') { if (second.value !== (pay.outcome || '')) e.outcome = second.value; if (third.value !== (pay.done_when || '')) e.done_when = third.value; }
        else if (second.value !== (pay.body || '')) e.body = second.value;
        return e;
    };
    const finish = res => { if (res.ok) { d.close(); showToast(res.text, false, 4000); } else { status.textContent = res.text; approve.disabled = rejectOpen.disabled = false; } };
    approve.addEventListener('click', async () => { approve.disabled = rejectOpen.disabled = true; status.textContent = ''; finish(await decide(p, 'approve', edits())); });
    rejectOpen.addEventListener('click', async () => {
        if (reasonRow.hidden) { reasonRow.hidden = false; rejectOpen.textContent = 'Reject'; reason.focus(); return; }
        approve.disabled = rejectOpen.disabled = true; status.textContent = '';
        finish(await decide(p, 'reject', { reason: reason.value.trim() }));
    });
    editOpen.addEventListener('click', () => { editing = true; for (const [i, raw] of inputs) { i.value = raw; i.readOnly = false; } sayHidden(); editOpen.hidden = true; approve.textContent = 'Approve with these words'; title.focus(); });
    row.append(close, rejectOpen, editOpen, approve);
    const carried = [];
    if (facts.instructions) { const b = el('div', 'proposal-carried'); b.append(el('strong', null, 'Instructions it gives the assignee'), el('pre', 'proposal-pre', markedBlock(facts.instructions))); carried.push(b); }
    if (facts.outputs.length) { const b = el('div', 'proposal-carried'); b.append(el('strong', null, 'Outputs it requires')); const ul = el('ul', 'proposal-outputs'); for (const o of facts.outputs) ul.append(el('li', null, markedBlock(o))); b.append(ul); carried.push(b); }
    if (facts.also.length) carried.push(el('p', 'proposal-extra', markedBlock(`Also sets: ${facts.also.join('; ')}.`)));
    d.append(h, who, ...parts, ...carried, hidden, reasonRow, status, row);
    if (editing) sayHidden();
    d.addEventListener('close', () => { d.remove(); });
    document.body.append(d);
    d.showModal();
    (mode === 'reject' ? reason : mode === 'edit' ? title : approve).focus();
    return d;
}
