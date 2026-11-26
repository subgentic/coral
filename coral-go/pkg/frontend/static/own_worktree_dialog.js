/* A worker started in its own worktree (#21468, mocks v3 idea 3): its Archive dialog has a tick box, "Also remove its worktree", and the header says where it works. Lazy: agent_actions.js and kill_session.js load it
 * only for a worker that has one. The server removes the folder only when it is clean and always keeps the branch; what it did comes back in the answer. */
import { showConfirmModal } from './confirm_dialog.js';
import { showToast } from './utils.js';
import { serverFetch } from './server_base.js';
import { agentWords, WHAT_STAYS_ARCHIVE } from './agent_words.js';
import { resolveSessionIdentity } from './session_state.js';

/** The dialog of the mock: Archive "<worker>"? with the tick box (on, as the mock draws it) and what it does. onAnswer(removeWorktree) runs on Archive, onCancel() on Cancel. */
export function askArchive(label, worktreeName, onAnswer, onCancel) {
    showConfirmModal(`Archive "${label}"?`, 'It leaves the sidebar. You can start it again from Archived.', (_ack, remove) => onAnswer(!!remove), onCancel,
        { label: 'Archive', danger: false, choice: { label: 'Also remove its worktree', checked: true } });
    const box = document.getElementById('confirm-modal-choice');
    if (!box) return;
    const tick = box.querySelector('input'), words = document.createElement('div'), title = document.createElement('b'), help = document.createElement('div'), code = document.createElement('code');
    title.textContent = 'Also remove its worktree';
    code.textContent = worktreeName;
    help.className = 'text-muted-sm';
    help.append('The folder ', code, ' is deleted. The branch is kept.');
    words.append(title, help); // the tick box's words and, under them, what it does (the mock)
    box.replaceChildren(tick, words);
}

/** What the archive answered about the worktree, in the same words an orchestrator's command gets (the Activity row has them too). */
export function tellWorktree(label, wt) {
    if (!wt || wt.state === 'none') return;
    if (wt.state === 'removed') showToast(`Its worktree ${wt.name} was removed. The branch is kept.`);
    else showToast(`${label} was archived, but its worktree was kept: ${wt.reason || ''}`.trim());
}

/** The header's chip: "Own worktree · task-N" for a worker started in its own worktree, gone for any other (the project folder shows as it did). */
export function paintChip(name) {
    for (const c of document.querySelectorAll('.own-worktree-chip')) {
        c.hidden = !name; c.textContent = name ? 'Own worktree \u00b7 ' + name : '';
        Object.assign(c.style, { border: '1px solid var(--border-light)', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }); // the mock's chip: an outline, no fill (a lazy module's own style, so the start sheet stays as it is)
    }
}

/** The person's Archive (moved here from agent_actions.js to keep the start path small): the usual question, or for a worker started in its own worktree (#21468) the dialog with the tick box. On Archive with the tick on,
 *  the archive that also removes the folder goes first (the server keeps the folder when it has changes that are not committed, and says why); then doIt, the usual archive step, so the list and the open page follow.
 *  Resolves true once archived, false when cancelled or failed. */
export function confirmArchive(s, name, server, doIt) {
    const label = agentWords(s, s ? resolveSessionIdentity(s) : name).label;
    if (!s?.own_worktree) {
        const stops = s && !s.sleeping ? ' It stops now.' : '';
        return new Promise(resolve => showConfirmModal('Archive agent',
            `Archive ${label}?${stops} Archived agents are not woken with their team or by Wake All. ${WHAT_STAYS_ARCHIVE}`,
            async () => resolve(await doIt()), () => resolve(false), { danger: false, label: 'Archive' }));
    }
    return new Promise(resolve => askArchive(label, s.own_worktree, async remove => {
        if (remove) {
            try {
                const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(s.session_id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove_worktree: true }) });
                const data = await resp.json();
                if (!resp.ok || !data.ok) { showToast(data.error || 'Failed to archive agent', true); resolve(false); return; }
                tellWorktree(label, data.worktree);
            } catch (e) { showToast('Failed to archive agent', true); resolve(false); return; }
        }
        resolve(await doIt());
    }, () => resolve(false)));
}
