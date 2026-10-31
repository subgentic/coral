/* What agents asked to add to a team, waiting for the Operator (#11389): the proposals of the teams whose goals or tasks need approval, read from GET /api/proposals and shown as rows of Needs you. Approve makes the
 * goal or task exactly as proposed; Edit and approve changes its words first; Reject says no, with a reason the proposer is told once. Everything the agents wrote is set as text (textContent, a field's value),
 * never as HTML. The Operator's alone: the machine answers a guest or a grantee 403, and then there are no rows. An expired proposal stays in the list, marked, until the Operator dismisses it here. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { visibleName } from './artifact_names.js';
import { loadStyles } from './lazy_styles.js';
const { proposalItems, pendingProposals, onProposalsChanged, refreshProposals, dismissExpired, decide } = await importOnce('./proposals_state.js'); // lazy: its failure is retried
const { el } = await importOnce('./data_table.js');
await loadStyles('inbox_proposals.css');
export { proposalItems, pendingProposals, onProposalsChanged, refreshProposals };

const kindWord = p => (p.kind === 'goal' ? 'goal' : 'task');

/** The fields of a proposal's payload the dialog and the row show. */
export function proposalFacts(p) {
    const pay = p.payload && typeof p.payload === 'object' ? p.payload : {};
    return p.kind === 'goal'
        ? { body: pay.outcome || '', extra: pay.done_when ? `Done when: ${pay.done_when}` : '' }
        : { body: pay.body || '', extra: [pay.assigned_to ? `For ${pay.assigned_to}` : '', pay.priority ? `Priority ${pay.priority}` : ''].filter(Boolean).join(' · ') };
}

/** The line a row says: who proposed what. */
export const proposalSummary = p => `Proposes a ${kindWord(p)}: ${visibleName(p.title)}`;

/** The buttons of a row: Approve, Edit and approve, Reject (an expired one has Dismiss). onMore opens the dialog in a mode. */
export function proposalActions(p) {
    const box = el('div', 'inbox-review-actions inbox-proposal-actions');
    const say = el('span', 'inbox-review-error'); say.setAttribute('role', 'alert');
    const btn = (label, aria, run, cls = 'btn btn-small') => { const b = el('button', cls, label); b.type = 'button'; b.setAttribute('aria-label', aria); b.addEventListener('click', e => { e.stopPropagation(); run(b); }); return b; };
    if (p.state === 'expired') {
        box.append(el('span', 'inbox-proposal-expired', 'Expired, nothing was made'), btn('Dismiss', `Dismiss the expired ${kindWord(p)} ${visibleName(p.title)}`, () => dismissExpired(p)));
        return box;
    }
    if (p.state === 'approving') { box.append(el('span', 'inbox-proposal-expired', 'Being approved…')); return box; } // an Approve has it: nothing to press until it finishes (a stuck one is looked into after five minutes)
    const approve = btn('Approve', `Approve the ${kindWord(p)} ${visibleName(p.title)}`, async b => {
        b.disabled = true; say.textContent = '';
        const res = await decide(p, 'approve');
        if (res.ok) showToast(res.text, false, 4000); else { b.disabled = false; say.textContent = res.text; }
    });
    box.append(approve,
        btn('Edit and approve', `Edit and approve the ${kindWord(p)} ${visibleName(p.title)}`, () => openProposalDialog(p, 'edit')),
        btn('Reject', `Reject the ${kindWord(p)} ${visibleName(p.title)}`, () => openProposalDialog(p, 'reject')), say);
    return box;
}

/** The dialog of a proposal: its words, who proposed it and for which team, and the three decisions. mode: 'view' | 'edit' | 'reject' (which part is open first). */
export function openProposalDialog(p, mode = 'view') {
    document.getElementById('proposal-dialog')?.remove();
    const facts = proposalFacts(p), pay = p.payload && typeof p.payload === 'object' ? p.payload : {};
    const d = el('dialog', 'modal-content dlg-form proposal-dialog'); d.id = 'proposal-dialog'; d.setAttribute('aria-labelledby', 'proposal-dialog-title');
    const h = el('h2', null, `${kindWord(p) === 'goal' ? 'A goal' : 'A task'} waiting for your approval`); h.id = 'proposal-dialog-title';
    const who = el('p', 'proposal-who', `${p.proposer} proposed it for ${p.board_id}.${p.goal_proposal_id ? ' It is for a goal that is also waiting: approve that goal first.' : ''}`);
    const field = (label, value, tall) => { const l = el('label', 'proposal-field'); l.append(el('span', null, label)); const i = el(tall ? 'textarea' : 'input', 'field'); if (tall) i.rows = 4; i.value = value; l.append(i); return [l, i]; };
    const [tl, title] = field('Title', p.title);
    const parts = [tl];
    let second = null, third = null;
    if (p.kind === 'goal') { const [ol, o] = field('Outcome', pay.outcome || '', true); const [dl, dw] = field('Done when', pay.done_when || ''); second = o; third = dw; parts.push(ol, dl); }
    else { const [bl, b] = field('Details', pay.body || '', true); second = b; parts.push(bl); }
    const why = field('Reason (the agent is told)', '', true), reason = why[1];
    const reasonRow = why[0]; reasonRow.hidden = mode !== 'reject';
    const status = el('p', 'proposal-status'); status.setAttribute('role', 'alert');
    const row = el('div', 'modal-actions proposal-buttons');
    const close = el('button', 'btn', 'Close'); close.type = 'button'; close.addEventListener('click', () => d.close());
    const approve = el('button', 'btn btn-primary', mode === 'edit' ? 'Approve with these words' : 'Approve'); approve.type = 'button';
    const rejectOpen = el('button', 'btn btn-danger', mode === 'reject' ? 'Reject' : 'Reject…'); rejectOpen.type = 'button';
    const edits = () => {
        const e = {};
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
    row.append(close, rejectOpen, approve);
    d.append(h, who, ...parts, facts.extra ? el('p', 'proposal-extra', facts.extra) : '', reasonRow, status, row);
    d.addEventListener('close', () => { d.remove(); });
    document.body.append(d);
    d.showModal();
    (mode === 'reject' ? reason : mode === 'edit' ? title : approve).focus();
    return d;
}
