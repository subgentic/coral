/* Restart, same settings, asked first when the agent is in the middle of a turn (#15442). Lazy: the start path only names this module. A restart cannot be undone (it resumes the conversation),
 * so the turn it would stop is said before, and only for an agent that is working; one at rest stays one tap (#10297). */
import { state } from './state.js';
import { showConfirmModal } from './confirm_dialog.js';
import { restartSameSettings as restart } from './restart_flow.js';

export function restartSameSettings() {
    const cur = state.currentSession, row = cur && (state.liveSessions || []).find(s => s.session_id === cur.session_id);
    if (!row || !row.working) return restart();
    showConfirmModal('Restart agent', `${cur.name} is working right now. Restarting stops what it is doing and starts a new conversation; the old chat stays above.`, () => restart(), undefined, { label: 'Restart', danger: true });
}
