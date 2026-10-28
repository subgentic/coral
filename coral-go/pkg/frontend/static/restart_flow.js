/* restart flow: extracted from controls.js without behavior changes (#8372). */

import { importOnce } from './import_once.js';
import { sectionFocus } from './section_dialog.js';
import { moveRestarting } from './session_overlay.js';
import { state, sessionKey, saveSessionDraft } from './state.js';
import { showToast } from './utils.js';
import { loadAgentEvents, renderEventTimeline } from './agentic_state.js';
import { resetLiveHistory, effectiveLiveViewMode, showChatView } from './live_chat.js';
import { serverFetch, currentServer } from './server_base.js';
import { applySleepingView } from './sleeping_view.js';
import { loadModals } from './lazy_panels.js';
import { launchFlags } from './launch_flags.js';
import { pollEvery } from './overload.js';
import { _getXtermModule } from './control_runtime.js';

export function restartSession() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }
    showRestartModal();
}

async function showRestartModal() {
    // The agent config form (renderAgentConfigForm / getAgentConfig) lives with the
    // dialogs, which load on first use (#3140): load it before showing, so a restart
    // never goes out with an empty config. A failed load already showed a toast.
    try { await loadModals(); } catch { return; }
    const s = state.currentSession;
    document.getElementById('restart-wizard').dataset.who = s.display_name || s.name; // said in the header's step line (restartStage)

    // Render unified config form pre-filled from session
    if (window.renderAgentConfigForm) {
        window.renderAgentConfigForm('restart-acf', {
            showPreset: false,
            showName: false,
            sections: true,
            restart: true, // the New Agent shell: Agent, Persona, Permissions, Advanced (#7391)
            restartName: s.display_name || s.name,
            value: {
                agentType: s.agent_type || 'claude',
                model: s.model || '',
                thinking: s.thinking || undefined, // the level it was started with: shown, and kept by the restart (#4969)
                thinkingActual: s.thinking_actual || '', // what it last ran at: a note under Thinking when that differs (#5105)
                prompt: s.prompt || '',
                capabilities: s.capabilities || null,
            },
        });
    }

    restartStage('persona'); // Restart always opens on step 1
    document.getElementById("restart-modal").style.display = "flex";
    document.querySelector('#restart-modal .acf-prompt')?.focus();
}

const RESTART_STAGES = ['persona', 'agent'];
const RESTART_STAGE_NAMES = { persona: 'Persona', agent: 'Settings' };

/** Restart's two steps, New Agent's without its first (the agent is fixed): the persona page, then the settings tabs (Model, Permissions, Advanced). Restart is in the footer of the second only, as Launch is on New Agent's last step (#7779); launchFlags.launchFromAnyStep puts it in both. `arg` is a stage name, "next" or "back". */
export function restartStage(arg) {
    const wiz = document.getElementById('restart-wizard');
    if (!wiz) return;
    const at = RESTART_STAGES.indexOf(wiz.dataset.stage);
    const to = arg === 'next' ? RESTART_STAGES[Math.min(at + 1, RESTART_STAGES.length - 1)] : arg === 'back' ? RESTART_STAGES[Math.max(at - 1, 0)] : arg;
    if (!RESTART_STAGES.includes(to)) return;
    wiz.dataset.stage = to;
    const sub = `Step ${RESTART_STAGES.indexOf(to) + 1} of ${RESTART_STAGES.length}: ${RESTART_STAGE_NAMES[to]}`;
    const subEl = document.getElementById('restart-stage-sub'); // New Agent's header: the title names what it does, the line under it the step and its name: "Restart <name>", "Step 1 of 2: Persona" (#7886)
    const who = wiz.dataset.who || '';
    subEl.textContent = sub;
    const title = document.getElementById('restart-title');
    if (title) title.textContent = who ? `Restart ${who}` : 'Restart agent'; // the agent's name, written as text (it is the agent's own)
    document.getElementById('restart-back').hidden = to === 'persona';
    document.getElementById('restart-next').hidden = to === 'agent';
    document.getElementById('restart-go').hidden = to !== 'agent' && !launchFlags.launchFromAnyStep; // Restart is shown after Next, as New Agent's Launch is (#7779, the operator: "click next before showing the relaunch option")
    const live = document.getElementById('restart-stage-live'); if (live) live.textContent = sub;
    const modal = document.getElementById('restart-modal');
    if (to === 'agent') importOnce('./quiet_focus.js').then(m => m.quietFocus(modal), () => {}); // the selected tab takes the focus: no ring until a key is pressed (#7391)
    (to === 'persona' ? modal.querySelector('.acf-prompt') : sectionFocus(modal))?.focus();
}

export function hideRestartModal() {
    document.getElementById("restart-modal").style.display = "none";
}

// Polls until the replacement session is live, then ends its restart (the overlay goes if that agent is on screen) and runs onLive; ~30 s at most.
function watchRestarted(xtermMod, name, sessionId, agentType, onLive) {
    let pollCount = 0;
    const pollInterval = pollEvery(async () => {
        pollCount++;
        try {
            // The detail route needs the exact target, agent_type with session_id; without it the
            // answer is 400 and the terminal never reattached after a restart (#3469).
            const liveResp = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(name)}?session_id=${encodeURIComponent(sessionId)}&agent_type=${encodeURIComponent(agentType || '')}`);
            if (liveResp.ok) {
                clearInterval(pollInterval);
                xtermMod.setRestarting(false, sessionId);
                onLive();
                return;
            }
        } catch (_) { /* ignore fetch errors during poll */ }
        if (pollCount >= 15) {
            // Timeout after ~30s: the overlay goes and the Operator is told
            clearInterval(pollInterval);
            xtermMod.setRestarting(false, sessionId);
            showToast("Restart timed out — session may not have started", true);
        }
    }, 2000, { whenHidden: true }); // follows a Restart the user just asked for
}

/** The words typed to the agent being replaced are not for its replacement (#10297): the box and the saved draft are emptied before the new session takes the old one's place. */
function forgetDraft(session, oldId, newId) {
    for (const id of [oldId, newId]) { // the feed may already have moved the page's session to the new id: the draft is under whichever it had
        const key = id && sessionKey({ ...session, session_id: id });
        if (key) saveSessionDraft(key, '');
    }
    const input = document.getElementById('command-input');
    if (input && state.currentSession === session) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
}

export async function confirmRestart() {
    const config = window.getAgentConfig ? window.getAgentConfig('restart-acf') : {};

    hideRestartModal();
    return runRestart(config);
}

/** Restart with what the agent was started with: one tap, no dialog (the Restart item's dialog is for changing something). The server keeps the stored settings when the request carries none (#10297). */
export async function restartSameSettings() {
    if (!state.currentSession || state.currentSession.type !== 'live') { showToast('No live session selected', true); return; }
    return runRestart({});
}

async function runRestart(config) {
    const restartId = state.currentSession && state.currentSession.session_id;
    try {
        // Show restarting overlay instead of session-ended
        const xtermMod = await _getXtermModule();
        if (xtermMod.setRestarting) xtermMod.setRestarting(true, restartId);
        showToast(`Restarting ${state.currentSession.name}...`, false, undefined, { group: { key: 'restarting', text: n => `Restarting ${n} agents` } });
        const replaced = state.currentSession;
        const payload = { agent_type: config.agentType || state.currentSession.agent_type, session_id: state.currentSession.session_id };
        if (config.flags) {
            payload.extra_flags = config.flags;
        }
        if (config.prompt) payload.prompt = config.prompt;
        if (config.model !== undefined) payload.model = config.model;
        if (config.thinking !== undefined) payload.thinking = config.thinking; // only when chosen: a restart keeps the agent's level otherwise (#4969)
        if (config.capabilities) payload.capabilities = config.capabilities;
        const resp = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/restart`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (result.error) {
            xtermMod.setRestarting(false, restartId);
            showToast(result.error, true);
        } else if (!state.currentSession || (state.currentSession.session_id !== restartId && state.currentSession.session_id !== result.session_id)) { // the feed may already have shown the replacement under the agent's name: that is still this agent (#10297)
            // The Operator switched to another agent while this one restarted: the screen belongs to that agent now, so nothing of it is
            // touched; the restarting mark moves to the replacement session and ends when that one is live (#4481).
            const replacement = result.session_id || restartId;
            forgetDraft(replaced, restartId, result.session_id);
            moveRestarting(restartId, replacement);
            const name = result.session_name || result.agent_name || '';
            watchRestarted(xtermMod, name, replacement, config.agentType || payload.agent_type, () => {});
        } else {
            // A restarted sleeping agent is running again
            forgetDraft(replaced, restartId, result.session_id); // before the session id changes: the saved draft is kept under the old one
            state.currentSession.sleeping = false;
            applySleepingView(false);
            // Update state with the new session_id (tmux session was renamed)
            if (result.session_id) {
                state.currentSession.session_id = result.session_id;
                moveRestarting(restartId, result.session_id); // the restart is now the replacement session's
            }
            if (config.agentType) {
                state.currentSession.agent_type = config.agentType;
            }
            // Restart renames the tmux session and returns its canonical name.
            // Keep the browser target aligned with the replacement session.
            const restartedName = result.session_name || result.agent_name;
            // The terminal reconnects to the replacement tmux session, not the old one (#3469).
            state.currentSession.tmux_session = result.session_name || null;
            if (restartedName) {
                state.currentSession.name = restartedName;
                document.getElementById("session-name").textContent = restartedName;
            }
            // The replacement session has an independent transcript and count.
            // Drop the old reader generation before the next poll, otherwise an
            // empty/new transcript is queried with the old session's offset.
            resetLiveHistory({ resume: true, keepEarlier: true, forSession: state.currentSession.session_id }); // the conversation so far stays above the new one (#10297)
            showChatView(); // a restart opens in Chat: the earlier conversation and the new session's first words, not a terminal starting up
            // Clear activity data immediately so the UI shows zero for the new session
            state.currentAgentEvents = [];
            renderEventTimeline();
            // Reload events for the new session_id
            loadAgentEvents(state.currentSession.name, state.currentSession.session_id);
            showToast(`Restarted: ${state.currentSession.name}`);

            // Reconnect terminal WebSocket to the new session.
            // Poll until the new session is live, then connect.
            const newName = state.currentSession.name;
            const newSessionId = state.currentSession.session_id;
            const newAgentType = state.currentSession.agent_type;
            watchRestarted(xtermMod, newName, newSessionId, newAgentType, () => {
                if (state.currentSession && state.currentSession.session_id === newSessionId) showChatView(); // the feed's replacement of the row may have selected it again, with the view the person had last (#10297)
                // Chat view has no terminal socket to take over (#3719): the Terminal view attaches when it is shown.
                if (state.currentSession && state.currentSession.session_id === newSessionId && effectiveLiveViewMode() === 'terminal') xtermMod.connectTerminalWs(state.currentSession.tmux_session || newName, newAgentType, newSessionId, currentServer());
            });
        }
    } catch (e) {
        if (restartId) _getXtermModule().then((m) => m.setRestarting(false, restartId)).catch(() => {});
        showToast("Failed to restart session", true);
        console.error("confirmRestart exception:", e);
    }
}
