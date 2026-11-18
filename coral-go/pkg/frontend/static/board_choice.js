/* A launch that names a board that already exists (#3536): Coral answers 409 board_name_exists
   with the boards of that name, and the person chooses: join one of them, or start another
   board with the same name. There is no default: the launch waits for the choice, and Cancel
   (or Escape, or the backdrop) launches nothing. Every name and date is set as text. */

/** The launch body for the choice: join sends that board's id (and its key as board_name, which
 *  a Coral from before board ids reads the same way); another sends new_board. */
export function retryPayload(payload, pick) {
    if (pick && pick.board_id) return { ...payload, board_id: pick.board_id, board_name: pick.board_id, new_board: undefined };
    if (pick && pick.new_board) return { ...payload, new_board: true, board_id: undefined };
    if (pick && pick.rename_old_board) return { ...payload, rename_old_board: true, board_id: undefined };
    return null;
}

/** "created Oct 12, 4 members, 2 running" for a candidate (live_agents since #3543). */
export function candidateDetail(c, locale) {
    const parts = [];
    const d = c && c.created_at ? new Date(c.created_at) : null;
    if (d && !isNaN(d)) parts.push(`created ${d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}`);
    const n = Number(c && c.members);
    if (Number.isFinite(n) && n >= 0) parts.push(`${n} member${n === 1 ? '' : 's'}`);
    const live = Number(c && c.live_agents);
    if (c && c.live_agents !== undefined && Number.isFinite(live) && live >= 0) parts.push(`${live} running`);
    return parts.join(', ');
}

/** Whether a launch answer is the duplicate-name refusal. */
export function isBoardNameExists(res) {
    return !!res && res.status === 409 && !!res.data && (res.data.code === 'board_name_exists' || res.data.error === 'board_name_exists');
}

/** Ask which board: resolves to { board_id } (join), { new_board: true } (another), or null. */
export function chooseBoard(data, name) {
    const candidates = Array.isArray(data && data.candidates) ? data.candidates.filter(c => c && c.board_id) : [];
    return new Promise(resolve => {
        const opener = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'modal board-choice-modal';
        overlay.id = 'board-choice-modal';
        overlay.style.display = 'flex';
        const box = document.createElement('div');
        box.className = 'modal-content dlg-confirm';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', 'board-choice-title');
        const h = document.createElement('h3');
        h.id = 'board-choice-title';
        h.textContent = candidates.length > 1 ? `Boards named "${name}" already exist` : `A board named "${name}" already exists`;
        const p = document.createElement('p');
        p.className = 'board-choice-text';
        p.textContent = 'Join it, so the agents share its messages and tasks, start another board with the same name, or rename the old team and start the new one.';
        box.append(h, p);

        const done = pick => {
            overlay.remove();
            if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
            resolve(pick);
        };
        const button = (text, cls, pick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = cls;
            b.textContent = text;
            b.addEventListener('click', () => done(pick));
            return b;
        };
        const list = document.createElement('div');
        list.className = 'board-choice-list';
        for (const c of candidates) {
            const row = document.createElement('div');
            row.className = 'board-choice-row';
            const label = document.createElement('span');
            label.className = 'board-choice-label';
            label.textContent = c.board_label || c.board_id;
            const detail = document.createElement('span');
            detail.className = 'board-choice-detail';
            detail.textContent = candidateDetail(c);
            const join = button('Join it', 'btn', { board_id: c.board_id });
            join.dataset.boardId = c.board_id;
            join.setAttribute('aria-label', `Join ${c.board_label || c.board_id}${detail.textContent ? ' (' + detail.textContent + ')' : ''}`);
            row.append(label, detail, join);
            list.appendChild(row);
        }
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancel = button('Cancel', 'btn', null);
        cancel.dataset.action = 'cancel';
        const another = button(`Create another "${name}"`, 'btn', { new_board: true });
        another.dataset.action = 'new';
        // One old team holding the name (#19724): free the name by relabelling it <name>-YYYY-MM-DD, then start the new team. Not offered for an ambiguous name; off, with the reason, while it has running agents.
        let whyEl = null;
        const renameTo = candidates.length === 1 && data && typeof data.rename_to === 'string' ? data.rename_to : '';
        actions.append(cancel);
        if (renameTo) {
            const running = data.rename_blocked === 'running_agents';
            const rename = button(`Rename the old team to "${renameTo}" and start the new one`, 'btn btn-primary', { rename_old_board: true });
            rename.dataset.action = 'rename-old';
            if (running) {
                rename.disabled = true;
                const why = document.createElement('p');
                why.className = 'board-choice-text board-choice-why';
                why.textContent = 'The old team has agents running, so it is not renamed under them. Stop them first, or use another name.';
                whyEl = why;
            }
            actions.append(rename);
        }
        actions.append(another);
        box.append(list, actions);
        if (whyEl) box.append(whyEl);
        overlay.appendChild(box);
        // Escape and the backdrop cancel this dialog only, never the launch dialog under it.
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.body.appendChild(overlay);
        cancel.focus(); // no choice is preselected
    });
}
