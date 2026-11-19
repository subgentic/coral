/* A launch that names a board that already exists (#3536): Coral answers 409 board_name_exists
   with the boards of that name, and the person chooses: join one of them, or start another
   board with the same name. There is no default: the launch waits for the choice, and Cancel
   (or Escape, or the backdrop) launches nothing. Every name and date is set as text. */

import { importOnce } from './import_once.js';

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

/** Ask which board (the dialog is loaded when first needed): resolves to { board_id } (join), { new_board: true } (another), { rename_old_board: true } (rename the old team) or null. */
export const chooseBoard = (data, name) => importOnce('./board_choice_dialog.js').then(m => m.chooseBoard(data, name));
