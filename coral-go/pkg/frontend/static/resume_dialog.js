/* Moved out of modals.js as it was (#3836): the Resume dialog loads on its own the first time it opens. */
import { state } from './state.js';
import { showToast } from './utils.js';
import { keyLabel, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
import { recordRecentDir } from './browser.js';
import { loadLiveSessions } from './api.js';
import { _getPermissionFlagsForAgentMode } from './permission_flags.js';

const MODE_WORDS = { default: 'Default', plan: 'Plan', acceptEdits: 'Accept edits', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions' };

// ── Resume Modal ───────────────────────────────────────────────────────────

export async function showResumeModal() {
    if (!state.currentSession || state.currentSession.type !== "history") {
        showToast("No history session selected", true);
        return;
    }

    const sessionId = state.currentSession.name;
    if (!isCloud() && !state.historySessionsList.some(s => s.session_id === sessionId)) await importOnce('./history_filters.js').then(m => m.ensureHistoryList()).catch(() => {}); // a local Coral reads its chat list when an entry is wanted (#8195)
    if (state.currentSession?.name !== sessionId) return; // another chat opened while it loaded
    const historyEntry = state.historySessionsList.find(s => s.session_id === sessionId);
    // The list entry, else the loaded transcript (a /chats/<id> link that is not
    // in the list); /resume-info below overrides both. Never guess a type.
    let agentType = historyEntry?.source_type || state.currentSession.agent_type || "";

    const dirInput = document.getElementById("resume-dir");
    const boardRow = document.getElementById("resume-board-row");
    const boardNameEl = document.getElementById("resume-board-name");

    // Fetch resume metadata (working dir, board, display name) from the server
    let resumeDir = "";
    let boardName = "";
    let displayName = "";
    let resumeSessionId = sessionId;
    let ranMode = ""; // the mode it ran in: the recorded one, else where the transcript keeps it (#10487)
    let ranIn = "", ranInExists = true; // the folder the session ran in, from its transcript or live row (#10291)
    try {
        const resp = await fetch(`/api/sessions/history/${encodeURIComponent(sessionId)}/resume-info`);
        if (resp.ok) {
            const info = await resp.json();
            if (info.permission_mode) ranMode = info.permission_mode;
            if (info.working_dir) resumeDir = info.working_dir;
            if (info.working_dir && info.working_dir_from === "session") { ranIn = info.working_dir; ranInExists = info.working_dir_exists !== false; }
            if (info.board_name) boardName = info.board_name;
            if (info.agent_type) agentType = info.agent_type;
            if (info.resume_session_id) resumeSessionId = info.resume_session_id;
            if (info.display_name) displayName = info.display_name;
        }
    } catch (_) { /* best-effort */ }
    if (!agentType) {
        showToast("Can't resume: this session's agent type is unknown", true);
        return;
    }

    // Pre-fill working directory: saved working dir > settings default > coral root
    const defaultDir = resumeDir || state.settings?.default_working_dir || dirInput.dataset.coralRoot || "";
    dirInput.value = defaultDir;
    const modalEl = document.getElementById("resume-modal");
    modalEl.dataset.ranIn = ranIn;
    modalEl.dataset.ranInExists = ranInExists ? "1" : "0";
    modalEl.dataset.ranMode = ranMode;
    syncResumeModeNote();
    if (!dirInput.dataset.noteWired) { dirInput.dataset.noteWired = "1"; dirInput.addEventListener("input", syncResumeDirNote); }
    syncResumeDirNote();

    // Show board reconnect option if the session was on a board
    if (boardName) {
        boardNameEl.textContent = keyLabel(boardName); // its label; the key rejoins it (#3536)
        boardNameEl.dataset.boardKey = boardName;
        boardRow.style.display = "";
        document.getElementById("resume-board-check").checked = true;
    } else {
        boardRow.style.display = "none";
        delete boardNameEl.dataset.boardKey; // never rejoin the previous chat's board
    }

    // Store agent type and display name for the launch function
    const modal = document.getElementById("resume-modal");
    modal.dataset.agentType = agentType;
    modal.dataset.displayName = displayName || historyEntry?.display_name || "";
    modal.dataset.resumeSessionId = resumeSessionId;
    modal.style.display = "flex";
}

/** Under the folder: the mode the chat resumes in. It keeps the mode it ran in, never the saved default (a Plan or Default chat resumed in Auto was the gap, #10487); with none recorded the saved default applies and says so. */
function syncResumeModeNote() {
    const modal = document.getElementById("resume-modal"), note = document.getElementById("resume-mode-note");
    if (!modal || !note) return;
    const mode = modal.dataset.ranMode || "";
    const words = mode ? `Resumes in ${MODE_WORDS[mode] || mode} mode, the mode this chat ran in.` : "This chat's mode was not recorded: it resumes in your saved default mode.";
    if (note.textContent !== words) note.textContent = words;
    note.hidden = false;
}

/** Under the folder: where the session ran, and a warning when the folder is changed (its files may not be found) or gone. Written only when the words change. */
function syncResumeDirNote() {
    const modal = document.getElementById("resume-modal"), note = document.getElementById("resume-dir-note"), input = document.getElementById("resume-dir");
    if (!modal || !note || !input) return;
    const ranIn = modal.dataset.ranIn || "";
    let words = "";
    if (ranIn) {
        const changed = input.value.trim() !== ranIn;
        if (modal.dataset.ranInExists === "0") words = `This session ran in ${ranIn}, which is not there any more. Choose a folder to resume in.`;
        else if (changed) words = `This session ran in ${ranIn}. Resuming somewhere else may not find the files it worked on.`;
        else words = "This is where the session ran.";
    }
    if (note.textContent !== words) note.textContent = words;
    note.hidden = !words;
    note.classList.toggle("is-warning", !!ranIn && (modal.dataset.ranInExists === "0" || input.value.trim() !== ranIn));
}

export function hideResumeModal() {
    document.getElementById("resume-modal").style.display = "none";
    // Hide browser if open
    const browser = document.getElementById("resume-dir-browser");
    if (browser) browser.style.display = "none";
}

export async function resumeLaunchNew() {
    if (!state.currentSession || state.currentSession.type !== "history") {
        showToast("No history session selected", true);
        return;
    }

    const sessionId = state.currentSession.name;
    const dir = document.getElementById("resume-dir").value.trim();
    if (!dir) {
        showToast("Working directory is required", true);
        return;
    }

    const modal = document.getElementById("resume-modal");
    const agentType = modal.dataset.agentType;
    if (!agentType) {
        showToast("Can't resume: this session's agent type is unknown", true);
        return;
    }
    const resumeSessionId = modal.dataset.resumeSessionId || sessionId;
    const displayName = modal.dataset.displayName || "";
    const boardCheck = document.getElementById("resume-board-check");
    const boardNameEl = document.getElementById("resume-board-name");
    const boardName = (boardCheck && boardCheck.checked && boardNameEl) ? (boardNameEl.dataset.boardKey || "") : "";

    const btn = document.getElementById("btn-resume-launch");
    if (btn) { btn.disabled = true; btn.textContent = "Resuming..."; }

    try {
        const payload = {
            working_dir: dir,
            agent_type: agentType,
            resume_session_id: resumeSessionId,
        };
        // The mode it ran in is kept: Default is the one mode a launch names (permission_mode), the others are the CLI's own flags for it; with none recorded nothing is sent and the saved default applies (#10487).
        const ranMode = modal.dataset.ranMode || "";
        if (ranMode === "default") payload.permission_mode = "default";
        else if (ranMode) { const flags = _getPermissionFlagsForAgentMode(agentType, ranMode).split(/\s+/).filter(Boolean); if (flags.length) payload.flags = flags; }
        if (displayName) payload.display_name = displayName;
        if (boardName) payload.board_id = payload.board_name = boardName; // rejoins that board (#3536)

        const resp = await fetch("/api/sessions/launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (result.error) {
            showToast(result.error, true);
        } else {
            recordRecentDir(dir);
            showToast(`Resumed session as new agent`);
            hideResumeModal();
            openResumedAgent(result, agentType); // the person asked for this agent: it opens when it is ready (#10291)
            setTimeout(loadLiveSessions, 2000);
        }
    } catch (e) {
        showToast("Failed to resume session", true);
        console.error("resumeLaunchNew error:", e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Resume"; }
    }
}

/** Opens the agent a Resume just started, in its chat, once the live list has it: the list is read now and again until the agent is in it (about 12 s at most), and a person who has opened something else meanwhile is not taken away from it. */
async function openResumedAgent(result, agentType) {
    const sid = result && (result.session_id || result.id);
    if (!sid) return;
    const was = state.currentSession && state.currentSession.session_id;
    for (let i = 0; i < 24; i++) {
        try { await loadLiveSessions(); } catch { /* the next look */ }
        const row = (state.liveSessions || []).find(s => s.session_id === sid);
        if (row) {
            const cur = state.currentSession && state.currentSession.session_id;
            if (cur && cur !== was && cur !== sid) return; // the person went elsewhere
            await window.selectLiveSession(row.name, row.agent_type || agentType, sid, row.server || "local");
            window.showChatView?.();
            return;
        }
        await new Promise(r => setTimeout(r, 500)); // interval-ok: a bounded wait for the new agent to be listed
    }
}
