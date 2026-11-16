// One notice per recorded waiting episode, even if a transient feed update clears it.
import { state } from './state.js';
import { sessionServer } from './server_base.js';
import { resolveSessionIdentity, askWords } from './session_state.js';
import { withTeam } from './team_names.js';
import { dialogDue, DIALOG_WORDS } from './at_dialog.js';
import { showNotificationToast, escapeHtml } from './utils.js';
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';
const shown = new Map();
export function raiseNeedsInputAlert(s, id) {
    const since = s.waiting_since;
    if (since && shown.get(id) === since) return;
    if (since) shown.set(id, since);
    const label = escapeHtml(withTeam(resolveSessionIdentity(s), s)); // the role or the name the row shows (the row's own words), not the folder twice; two teams: "Orchestrator (team-a)" (#10134)
    const detail = s.waiting_summary ? escapeHtml(askWords(s.waiting_summary)) : dialogDue(s) ? escapeHtml(DIALOG_WORDS) : null; // an agent at a dialog says it needs one click (#11430)
    const sessionName = s.name;
    const agentType = s.agent_type;
    const sessionId = s.session_id;
    const sessionSrv = sessionServer(s);
    const openSession = () => importOnce('./sessions.js').then(m => m.selectLiveSession(sessionName, agentType, sessionId, sessionSrv)).then(() => window.showChatView?.()); // the chat card is where the answer is (#10141)
    // The question is announced once: with its card on screen in this agent's chat (a role=alert that says it) the toast is there to see and use but does not say it again (#10374).
    const cardShown = state.currentSession?.session_id === sessionId && [...document.querySelectorAll('#live-history-messages > .chat-needs-input')].some(e => e.getClientRects().length > 0);
    // Phone, Needs you open: the row is the notice, a toast would cover it (#17733)
    const t = document.getElementById('group-table-view');
    if (!(isPhoneLayout() && t?.dataset.group === 'hub-inbox:needs' && t.getClientRects().length)) showNotificationToast(label, detail, openSession, { silent: cardShown });
    // Opt-in desktop alert while this tab is in the background; names only.
    // attention.js is read when the first alert is due, not at start (the start weight is guarded): the count it keeps is only ever needed from then on
    // Whether the tab is in the background is decided now, when the alert is raised: attention.js answers after it has loaded, and a tab that was visible at the reply and hidden by then must not count it (#10396)
    if (document.hidden) importOnce('./attention.js').then(m => m.noteRow(m.KIND_NEEDS_INPUT, s, id, openSession)).catch(() => {});
}

