/* What the sidebar's menus do to one agent: kill, info, attach, restart, sleep and archive (moved out of render.js, #4996; no behaviour change). */
import { state } from './state.js';
import { worktreeConfirmWords } from './worktree_words.js';
import { showWorktreeNotice } from './worktree_notice.js';
import { serverFetch, serverForSession, sessionServer } from './server_base.js';
import { killLiveSession, dropKilledRows } from './kill_live.js';
import { showToast, showView } from './utils.js';
import { redrawLiveList } from './list_hooks.js';
import { showConfirmModal } from './confirm_dialog.js';
import { importOnce } from './import_once.js';
import { resolveSessionIdentity } from './session_state.js';
import { agentWords, whatStaysKill, WHAT_STAYS_ARCHIVE, WHAT_STAYS_SLEEP } from './agent_words.js';
import { applySleepingView } from './sleeping_view.js';

// What Kill does with the agent's terminal log, said in every Kill confirmation (#4399): it is kept, on both terminal backends
// (#4437: tmux's KillSession no longer removes it), in <data dir>/logs.
export const KILL_LOG_NOTE = "Its terminal log is kept, in the logs folder of Coral's data folder.";

// The same for a confirmation about several agents (Kill All Agents, Kill Team, Reset Team: Reset kills each agent and
// starts it again under a new session id, so the old logs stay as they are).
export const KILL_LOG_NOTE_MANY = "Their terminal logs are kept, in the logs folder of Coral's data folder.";

// Reset's own, in plain words: it is the one confirmation that is not about ending anything, and where the folder is is Settings' to say (#10549).
export const RESET_LOG_NOTE = "Their terminal logs are kept.";

// killCount is "the 1 agent" or "all 3 agents", and its log note to match.
export function killCount(n) {
    return n === 1 ? { agents: 'the 1 agent', note: KILL_LOG_NOTE } : { agents: `all ${n} agents`, note: KILL_LOG_NOTE_MANY };
}

export function killSessionDirect(name, agentType, sessionId) {
    const server = serverForSession(name, sessionId);
    const row = (state.liveSessions || []).find(s => s.session_id === sessionId);
    const who = agentWords(row, row ? resolveSessionIdentity(row) : name).label; // the agent by its role and team, not the folder it works in (#10139)
    showConfirmModal('Kill session', `Kill ${who}? This will terminate the agent. ${whatStaysKill([row || { agent_type: agentType }])} ${row && row.git_state && row.git_state.is_worktree ? worktreeConfirmWords(row.branch) + ' ' : ''}${KILL_LOG_NOTE}`, async () => { try {
        const result = await killLiveSession({ name, agent_type: agentType, session_id: sessionId }, server);
        if (!result) throw new Error('the kill answer was not JSON');
        if (result.error) { showToast(result.error, true); return; }
        if (result.changes_artifact_error) {
            showToast(`Killed, but changes.diff could not be saved: ${result.changes_artifact_error}`, true);
        } else {
            showToast(`Killed and saved changes.diff: ${who}`);
        }
        showWorktreeNotice(result.worktree, 'agent'); // what became of its worktree, if it had one (#6707); a kept one stays on screen with its path (#6818)
        // The row goes at once: the agent's chat stays in History. A killed agent is not listed again.
        dropKilledRows([{ session_id: sessionId, server }]);
        if (state.currentSession && state.currentSession.session_id === sessionId) {
            state.currentSession = null;
            showView("welcome-screen");
        }
    } catch (e) {
        showToast("Failed to kill session", true);
    } }, undefined, { label: 'Kill session', danger: true });
}

export async function showInfoDirect(name, agentType, sessionId) {
    const { selectLiveSession } = await importOnce('./sessions.js');
    await selectLiveSession(name, agentType, sessionId, serverForSession(name, sessionId));
    const { showInfoModal } = await importOnce('./modals.js');
    showInfoModal();
}

export async function attachDirect(name, agentType, sessionId) {
    try {
        const resp = await serverFetch(serverForSession(name, sessionId), `/api/sessions/live/${encodeURIComponent(name)}/attach`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent_type: agentType, session_id: sessionId }),
        });
        const result = await resp.json();
        if (result.error) showToast(result.error, true);
        else showToast("Terminal opened");
    } catch (e) {
        showToast("Failed to open terminal", true);
    }
}

/** The agent on screen is this one: it is not selected again (that reloads its chat, and a restart's earlier conversation would go, #10297). */
function _isSelected(sessionId) {
    return !!(state.currentSession && state.currentSession.type === 'live' && state.currentSession.session_id === sessionId);
}

export async function restartDirect(name, agentType, sessionId) {
    const { selectLiveSession } = await importOnce('./sessions.js');
    if (!_isSelected(sessionId)) await selectLiveSession(name, agentType, sessionId, serverForSession(name, sessionId)); // selecting the agent already on screen would empty its chat
    const { restartSession } = await importOnce('./controls.js');
    restartSession();
}

/** Restart with the settings the agent was started with: one tap, no dialog (#10297). */
export async function restartSameDirect(name, agentType, sessionId) {
    const { selectLiveSession } = await importOnce('./sessions.js');
    if (!_isSelected(sessionId)) await selectLiveSession(name, agentType, sessionId, serverForSession(name, sessionId)); // selecting the agent already on screen would empty its chat
    const { restartSameSettings } = await importOnce('./restart_flow.js');
    restartSameSettings();
}

/** The Operator's per-agent switch for auto-sleep (#12111): mode 'off' keeps the agent awake however long it is idle, 'on' puts it back under the rule. Only Coral's own record changes. */
export async function setAgentAutoSleep(name, agentType, sessionId, mode) {
    const off = mode === 'off';
    const server = serverForSession(name, sessionId);
    try {
        const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(name)}/auto-sleep`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, agent_type: agentType, off }) });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) { showToast(data.error || 'Could not change auto-sleep', true); return false; }
        const row = state.liveSessions.find(x => x.session_id === sessionId && sessionServer(x) === server);
        if (row) { if (off) row.auto_sleep_off = true; else delete row.auto_sleep_off; }
        redrawLiveList();
        const who = agentWords(row, row ? resolveSessionIdentity(row) : name).label;
        showToast(off ? `${who} will stay awake` : `${who} can be put to sleep when idle`);
        return true;
    } catch { showToast('Could not change auto-sleep', true); return false; }
}

export function toggleAgentSleep(name, agentType, sessionId, action) {
    const server = serverForSession(name, sessionId);
    // Resolves true when the server applied the action.
    const doIt = async () => {
        try {
            const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(sessionId)}/${action}`, { method: 'POST' });
            const data = await resp.json();
            if (!data.ok) { showToast(data.error || 'Failed to toggle sleep', true); return false; }
            const sleeping = !!data.sleeping;
            const s = state.liveSessions.find(s => s.session_id === sessionId && sessionServer(s) === server);
            if (s) {
                s.sleeping = sleeping;
                if (!sleeping) s.archived = false; // waking unarchives (#3030)
                if (sleeping && action === 'sleep') s.sleep_reason = null; // a terminal-gone agent put to sleep is plain sleeping now (#13171)
            }
            redrawLiveList();
            const who = (s && s.display_name) || name; // the agent's name, not its folder ("home")
            showToast(sleeping ? `"${who}" is now sleeping` : `"${who}" is awake`);
            return true;
        } catch (e) {
            showToast('Failed to toggle agent sleep', true);
            return false;
        }
    };
    if (action === 'sleep') {
        const row = state.liveSessions.find(x => x.session_id === sessionId && sessionServer(x) === server);
        if (row && row.sleeping && !row.archived && row.sleep_reason === 'terminal_gone') return doIt(); // already asleep, nothing runs to stop: it is only filed under sleeping (#13171)
        const who = agentWords(row, row ? resolveSessionIdentity(row) : name).label; // the agent's own name and team, not the folder it works in (#10785)
        showConfirmModal('Sleep agent', `Put ${who} to sleep? ${WHAT_STAYS_SLEEP}`, doIt, undefined, { danger: false, label: 'Sleep agent' });
        return Promise.resolve(false);
    }
    return doIt();
}

/**
 * Sleep every agent in ids whose terminal is gone (#13171): they are asleep already, so this files them under sleeping (the "Terminal gone" chip goes, a later Wake resumes them as any sleeper). One request per
 * computer; resolves with how many the servers moved.
 */
export async function sleepTerminalGone(ids) {
    const byServer = new Map();
    for (const id of ids) {
        const row = state.liveSessions.find(x => x.session_id === id && x.sleeping && !x.archived && x.sleep_reason === 'terminal_gone');
        if (!row) continue;
        const server = sessionServer(row);
        if (!byServer.has(server)) byServer.set(server, []);
        byServer.get(server).push(id);
    }
    let moved = 0, failed = false;
    for (const [server, list] of byServer) {
        try {
            const resp = await serverFetch(server, '/api/sessions/live/sleep-gone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_ids: list }) });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) { failed = true; continue; }
            moved += Number(data.sessions_affected) || 0;
            for (const id of list) {
                const row = state.liveSessions.find(x => x.session_id === id && sessionServer(x) === server);
                if (row) row.sleep_reason = null;
            }
        } catch { failed = true; }
    }
    redrawLiveList();
    if (failed) showToast(moved ? `${moved} agent${moved === 1 ? ' is' : 's are'} now sleeping; some could not be moved` : 'Could not move the agents to sleeping', true);
    else if (moved) showToast(`${moved} agent${moved === 1 ? ' is' : 's are'} now sleeping`);
    return moved;
}

/**
 * Archive or unarchive one agent (#3030). Archiving stops a running agent and
 * keeps it out of team wake, Wake All and the main list; unarchiving leaves it
 * sleeping. Resolves true when the server applied it, false on failure or
 * when the archive confirmation is cancelled.
 */
export function toggleAgentArchive(name, agentType, sessionId, action) {
    const server = serverForSession(name, sessionId);
    const doIt = async () => {
        try {
            const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(sessionId)}/${action}`, { method: 'POST' });
            const data = await resp.json();
            if (!resp.ok || !data.ok) { showToast(data.error || `Failed to ${action} agent`, true); return false; }
            const s = state.liveSessions.find(s => s.session_id === sessionId && sessionServer(s) === server);
            if (s) { s.archived = !!data.archived; s.sleeping = !!data.sleeping; }
            redrawLiveList();
            // The agent on screen follows now, not on the next feed tick.
            const cur = state.currentSession;
            if (cur && cur.type === 'live' && cur.session_id === sessionId && sessionServer(cur) === server) {
                if (!!cur.sleeping !== !!data.sleeping) {
                    window.selectLiveSession(cur.name, cur.agent_type, cur.session_id, server);
                } else if (data.sleeping) {
                    applySleepingView(true, { archived: !!data.archived, manageInput: !document.body.classList.contains('popout-mode') });
                }
            }
            const label = agentWords(s, s ? resolveSessionIdentity(s) : name).label; // by role and team (#10139)
            showToast(data.archived ? `${label} is archived. Its chat history and files stay.` : `${label} is unarchived (sleeping)`);
            return true;
        } catch (e) {
            showToast(`Failed to ${action} agent`, true);
            return false;
        }
    };
    if (action === 'archive') {
        const s = state.liveSessions.find(s => s.session_id === sessionId && sessionServer(s) === server);
        const stops = s && !s.sleeping ? ' It stops now.' : ''; // a whole sentence for each state, never "It Archived agents..." (#10369)
        return new Promise(resolve => showConfirmModal('Archive agent',
            `Archive ${agentWords(s, s ? resolveSessionIdentity(s) : name).label}?${stops} Archived agents are not woken with their team or by Wake All. ${WHAT_STAYS_ARCHIVE}`,
            async () => resolve(await doIt()), () => resolve(false), { danger: false, label: 'Archive' }));
    }
    return doIt();
}
