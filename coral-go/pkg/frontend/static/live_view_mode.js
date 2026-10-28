/* Live view mode: persisted Chat/Terminal choice, application and terminal prefetch. Moved from live_chat.js (#8353). */

import { state } from './state.js';
import { fitTerminal, refreshTerminal } from './xterm_renderer.js';
import { loadXterm, xtermReady } from './vendor_loader.js';
import { fireAgentView } from './agent_view.js';
import { browserLocal } from './safe_storage.js';
import { syncJumpToLatest } from './chat_jump_latest.js';
import { autosizeCommandInput } from './command_autosize.js';
import { startLiveHistoryPoll, stopLiveHistoryPoll } from './live_history.js';

// ── Center view mode: terminal vs. chat ─────────────────────────────────
// The transcript renders in the center pane in place of the terminal. The
// terminal keeps running underneath (hidden) so switching back is instant.

const VIEW_MODE_KEY = "coral-live-view-mode";

/** The chosen center view; Chat unless the user picked Terminal. */
export function getLiveViewMode() {
    try {
        return browserLocal.get(VIEW_MODE_KEY) === "terminal" ? "terminal" : "chat";
    } catch {
        return "chat";
    }
}

// Plain terminals have no transcript, so they always show the terminal.
function hasTranscript(session) {
    return !!session && session.agent_type !== "terminal";
}

/** The view the selected agent shows in the centre: "chat" or "terminal". A plain terminal has no transcript,
 *  so it is always the terminal; otherwise the persisted mode, or a one-off override. */
// "Open terminal" on the needs-input card shows the terminal for this agent without changing the saved choice (#4711). The terminal
// attaches only for a view that wants it (sessions.js asks effectiveLiveViewMode), so the view that is showing has to be what is asked:
// until the next agent is selected, or a view is chosen with the toggle, the terminal is the view.
let _terminalOverride = false;
// An agent opened from something that says it needs an answer (a Needs you row, the toast's Open) shows the chat, where the card is, whatever view was saved last: for this agent only, the same way (#10141).
let _chatOverride = false;
export function clearViewOverride() { _terminalOverride = false; _chatOverride = false; }
export function effectiveLiveViewMode(override) {
    return hasTranscript(state.currentSession) ? (override || (_terminalOverride ? "terminal" : _chatOverride ? "chat" : getLiveViewMode())) : "terminal";
}

/** Apply the persisted mode (or a one-off override) to the DOM and start/stop the transcript poll. */
export function applyLiveViewMode(override) {
    const mode = effectiveLiveViewMode(override);
    const canChat = hasTranscript(state.currentSession);
    const toggle = document.querySelector(".live-view-toggle");
    if (toggle) toggle.hidden = !canChat;
    const findBtn = document.getElementById("chat-find-btn");
    if (findBtn) findBtn.hidden = mode !== "chat";
    if (mode !== "chat") window.closeChatFind?.();
    const wrapper = document.getElementById("capture-wrapper");
    if (wrapper) wrapper.classList.toggle("chat-mode", mode === "chat");
    // The command pane drops terminal-only controls in chat mode
    const pane = document.getElementById("command-pane");
    if (pane) pane.classList.toggle("chat-mode", mode === "chat");
    // The two inputs look alike: in the Terminal view the box under it is a message, not the terminal (#6676).
    document.getElementById('command-input')?.setAttribute('aria-label', mode === 'chat' ? 'Enter command or paste image' : 'Message to the agent, not typed into the terminal');
    autosizeCommandInput();
    for (const m of ["terminal", "chat"]) {
        const btn = document.getElementById(`live-view-btn-${m}`);
        if (!btn) continue;
        btn.classList.toggle("active", m === mode);
        btn.setAttribute("aria-pressed", String(m === mode));
    }
    if (mode === "chat") {
        // The terminal is not shown: its socket closes (sessions.js), and opens again when it is.
        fireAgentView("coral:terminal-unwanted");
        scheduleTerminalPrefetch();
        return startLiveHistoryPoll();
    } else {
        stopLiveHistoryPoll();
        // The terminal is shown: it attaches now if it has not (sessions.js; no socket or xterm.js in Chat view).
        fireAgentView("coral:terminal-wanted");
        // The xterm canvas was hidden; refit now that it has a size again, and repaint it: a renderer that was hidden may not
        // draw again until something is written, and an idle agent writes nothing (#4518).
        setTimeout(fitTerminal, 0);
        requestAnimationFrame(() => requestAnimationFrame(() => { fitTerminal(); refreshTerminal(); }));
    }
    return Promise.resolve();
}

// xterm.js (456 KB with its add-ons) is only downloaded when the Terminal view is first shown (#3083), and that wait, on a slow link
// or through Coral Hub, was the blank pane after the switch (#4518: about a second at 1.5 Mbit and 150 ms; measured). So it is fetched
// ahead: on the first sign that the Terminal button is about to be used (pointer over it, touch, focus), and when the Chat view has been
// showing for terminalPrefetch.idleMs on a link that is not metered or slow. It loads once; every later switch finds it ready.
export const terminalPrefetch = { idleMs: 2000 };
let _prefetchTimer = null;
export function prefetchTerminal() {
    if (xtermReady()) return;
    loadXterm().catch(() => { /* a failed prefetch is retried by the switch itself, which shows its own Retry */ });
}
function slowOrMetered() {
    const c = navigator.connection;
    return !!c && (c.saveData === true || /(^|-)2g$/.test(c.effectiveType || ""));
}
function scheduleTerminalPrefetch() {
    if (xtermReady() || _prefetchTimer || slowOrMetered() || !hasTranscript(state.currentSession) || state.currentSession.sleeping) return; // a sleeping agent has no terminal to show: nothing to fetch ahead (#9101)
    _prefetchTimer = setTimeout(() => {
        _prefetchTimer = null;
        if (effectiveLiveViewMode() === "chat" && !slowOrMetered()) prefetchTerminal();
    }, terminalPrefetch.idleMs);
}
export function setLiveViewMode(mode) {
    _terminalOverride = false; _chatOverride = false;
    try {
        browserLocal.set(VIEW_MODE_KEY, mode === "chat" ? "chat" : "terminal");
    } catch { /* storage unavailable — mode lasts for this page only */ }
    applyLiveViewMode();
    if (mode === "chat") {
        const container = document.getElementById("live-history-messages");
        if (container) container.scrollTop = container.scrollHeight;
        state.autoScroll = true;
        syncJumpToLatest();
    }
}

/** Show the chat for this agent without changing the saved Chat/Terminal choice (a row that says it needs an answer opened it). */
export function showChatView() {
    _chatOverride = true; _terminalOverride = false;
    applyLiveViewMode("chat");
}

/** Show the terminal for this agent without changing the saved Chat/Terminal choice. */
export function showTerminalView() {
    _terminalOverride = true; _chatOverride = false;
    applyLiveViewMode("terminal");
}
