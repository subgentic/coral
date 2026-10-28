/* Moved out of modals.js as it was (#3836): the Resume dialog loads on its own the first time it opens. */
import { state } from './state.js';
import { showToast } from './utils.js';
import { keyLabel, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
import { recordRecentDir } from './browser.js';
import { loadLiveSessions } from './api.js';

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
    let ranMode = "", ranFrom = ""; // the mode it ran in: Coral's own record ("session"), else where the transcript keeps it ("transcript": a hint, #10487)
    let ranIn = "", ranInExists = true; // the folder the session ran in, from its transcript or live row (#10291)
    try {
        const resp = await fetch(`/api/sessions/history/${encodeURIComponent(sessionId)}/resume-info`);
        if (resp.ok) {
            const info = await resp.json();
            if (info.permission_mode) { ranMode = info.permission_mode; ranFrom = info.permission_mode_from || "transcript"; }
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
    modalEl.dataset.ranModeFrom = ranFrom;
    await fillResumeModes(agentType);
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

// How permissive each mode is, narrowest first: a transcript's mode is only taken when it is no wider than the saved default (#10487).
const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, auto: 3, dontAsk: 4, bypassPermissions: 5 };
const savedMode = () => (state.settings && state.settings.default_permission_mode) || "default"; // none saved: Default is what a wider mode is measured against

/** The mode the dialog starts on: the one the chat ran in when Coral recorded it, or when its transcript's start is no wider than the saved default; else "" (the saved default). A transcript is a file, not Coral's record (one someone else sent could say Bypass): a wider mode is shown, and sent only when the person picks it. */
function startingMode(ranMode, ranFrom) {
    if (!ranMode) return "";
    if (ranFrom !== "transcript") return ranMode;
    return (MODE_RANK[ranMode] ?? 99) <= (MODE_RANK[savedMode()] ?? 0) ? ranMode : "";
}

/** The Resume in picker: the saved default first, then the modes this CLI has, on the starting mode. */
async function fillResumeModes(agentType) {
    const modal = document.getElementById("resume-modal"), row = document.getElementById("resume-mode-row"), sel = document.getElementById("resume-mode");
    if (!modal || !row || !sel) return;
    const { modeOffered } = await importOnce("./permission_flags.js");
    const saved = savedMode();
    sel.replaceChildren(new Option(`Saved default (${MODE_WORDS[saved] || saved})`, ""), ...Object.keys(MODE_WORDS).filter(m => modeOffered(agentType, m)).map(m => new Option(MODE_WORDS[m], m)));
    sel.value = startingMode(modal.dataset.ranMode || "", modal.dataset.ranModeFrom || "");
    modal.dataset.startMode = sel.value;
    row.hidden = false;
    syncResumeModeNote();
}

/** Under the folder: the mode the chat resumes in. It keeps the mode it ran in, never the saved default (a Plan or Default chat resumed in Auto was the gap, #10487); with none recorded the saved default applies and says so; a transcript's mode wider than the saved default is said and not taken. */
function syncResumeModeNote() {
    const modal = document.getElementById("resume-modal"), note = document.getElementById("resume-mode-note"), sel = document.getElementById("resume-mode");
    if (!modal || !note) return;
    const ran = modal.dataset.ranMode || "", from = modal.dataset.ranModeFrom || "", pick = sel ? sel.value : "";
    const name = m => `${MODE_WORDS[m] || m} mode`, saved = savedMode();
    let words;
    if (pick !== (modal.dataset.startMode || "")) words = pick ? `Resumes in ${name(pick)}, as you chose.` : `Resumes in your saved default mode (${MODE_WORDS[saved] || saved}), as you chose.`;
    else if (!ran) words = "This chat's mode was not recorded: it resumes in your saved default mode.";
    else if (from !== "transcript") words = `Resumes in ${name(ran)}, the mode this chat ran in.`;
    else if (pick) words = `Resumes in ${name(ran)}: this chat started in it.`;
    else words = `This chat started in ${name(ran)}; it resumes in your saved default (${MODE_WORDS[saved] || saved}). Choose the mode below to change it.`;
    if (note.textContent !== words) note.textContent = words;
    note.hidden = false;
}

export { syncResumeModeNote };

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
        // The mode picked (the mode the chat ran in, unless the person chose another, or it is a transcript's wider one): Default is the one mode a launch names (permission_mode), the others are the CLI's own flags for it; the saved default sends nothing (#10487).
        const pick = (document.getElementById("resume-mode") || {}).value || "";
        if (pick === "default") payload.permission_mode = "default";
        else if (pick) { const { _getPermissionFlagsForAgentMode } = await importOnce("./permission_flags.js"); const flags = _getPermissionFlagsForAgentMode(agentType, pick).split(/\s+/).filter(Boolean); if (flags.length) payload.flags = flags; }
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
