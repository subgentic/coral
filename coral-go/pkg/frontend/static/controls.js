// Keep the original dependency evaluation order (#8372).
import { rawKeyOk, rawKeySeq } from './raw_keys.js';
import './import_once.js';
import './session_overlay.js';
import { dashboardPromptRequested } from './dashboard_analytics.js';
import { mountSettingsView } from './settings_view.js';
import { state, sessionKey, saveSessionDraft } from './state.js';
import { updateSettingList, removeFirst } from './settings_lists.js';
import { claimOwnership } from './ownership.js';
import './section_dialog.js';
import { popoutTerminalBlocked } from './popout.js';
import { escapeHtml, escapeAttr, showToast, showView, setRowCurrent } from './utils.js';
import { registerActions, idOf } from './actions.js';
import { renderLiveSessions, KILL_LOG_NOTE } from './render.js';
import './agentic_state.js';
import { addPendingMessage, confirmPendingMessage, removePendingMessage } from './live_chat.js';
import { serverFetch, currentServer, serverForSession, sessionServer } from './server_base.js';
import { resolveSessionIdentity } from './session_state.js';
import { agentWords, WHAT_STAYS_KILL } from './agent_words.js';
import './sleeping_view.js';
import { hubBlocked } from './hub_access.js';
import './image_attach.js';
import { attachmentsLead, sentToastText } from './shared_images.js';
import './lazy_panels.js';
import { responseError } from './server_status.js';
import './launch_flags.js';
import { reportSendError, showComposerError, clearComposerError, awaitSocketAccept, nextInputId, refuseSocketSends } from './terminal_gone.js';
import { rememberSend, noteHeld } from './held_sends.js';
import './overload.js';
import { syncSendStarting } from './agent_starting.js';
import { worktreeConfirmWords } from './worktree_words.js';
import { showWorktreeNotice } from './worktree_notice.js';
import { killLiveSession, dropKilledRows } from './kill_live.js';
import { MODES, modeFromFooterText, pressesFor } from './mode_cycle.js';
import { _getXtermModule, sleepingBlocked } from './control_runtime.js';
import { activeUploadPromisesBySession, getPendingAttachments, clearAttachments, openImagePicker, removeAttachment, openAttachment } from './image_composer.js';
export { getPendingAttachments, initImageDrop, uploadAndInsertImage, renderAttachments, removeAttachment } from './image_composer.js';
export { restartSession, restartStage, hideRestartModal, confirmRestart } from './restart_flow.js';
/* Quick actions, command sending, mode toggling, and session controls */


let _isSending = false;

/** Send was pressed with nothing to send: focus the box and flash it once (#3770). */
function nudgeEmptyInput() {
    const input = document.getElementById("command-input");
    if (!input || input.disabled) return;
    input.focus();
    input.classList.remove("empty-send-nudge");
    void input.offsetWidth; // restart the animation if it is still running
    input.classList.add("empty-send-nudge");
    input.addEventListener("animationend", () => input.classList.remove("empty-send-nudge"), { once: true });
}

// nudge: the Send button was pressed (Enter on an empty box stays quiet).
export async function sendCommand({ nudge = false } = {}) {
    if (_isSending) return;
    const targetSession = state.currentSession;
    if (!targetSession || targetSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }
    if (sleepingBlocked()) return;
    if (popoutTerminalBlocked()) {
        showToast("Agent is not ready to receive input", true);
        return;
    }
    claimOwnership(); // sending from a viewer window takes interactive control

    const targetSessionId = targetSession.session_id;
    const targetSessionName = targetSession.name;
    const targetAgentType = targetSession.agent_type;

    _isSending = true;
    try {
        // Through the Cloud Hub, a View-only server drops terminal input silently:
        // refuse here so nothing says "Sent" and the draft is kept (#3068). Inside
        // the _isSending guard, so a double Enter cannot get past it twice.
        if (await hubBlocked(targetSession)) return;
        const activeUploads = activeUploadPromisesBySession.get(targetSessionId);
        if (activeUploads && activeUploads.length > 0) {
            showToast("Waiting for image upload to complete...");
            const results = await Promise.all(activeUploads);
            if (results.some(ok => ok === false)) {
                showToast("Image upload failed, message not sent", true);
                return;
            }
        }

        // Verify session did not change while waiting for uploads
        if (!state.currentSession || state.currentSession.session_id !== targetSessionId) {
            showToast("Session changed while uploading, send cancelled", true);
            return;
        }

        const input = document.getElementById("command-input");
        const textPart = input.value.trim();

        // Build the full command: image paths + text, space-separated
        const sessionAttachments = getPendingAttachments(targetSession);
        const parts = attachmentsLead(sessionAttachments); // each image's artifact link and one hint to fetch them, never the local path (#5481); the path only for an image with no artifact
        if (textPart) parts.push(textPart);

        const command = parts.join(" ");
        if (!command) { if (nudge) nudgeEmptyInput(); return; }
        if (targetAgentType !== 'terminal') dashboardPromptRequested();
        const sentSessionId = targetSessionId;
        const sentAt = Date.now();
        const hasAttachments = sessionAttachments.length > 0;

        // A message to an agent: one composer_send frame, answered only once the agent's input box has taken and
        // submitted it (#4587: an Enter typed while it started was lost, the text sat in its box, and Chat said Sent).
        if (!hasAttachments && targetAgentType !== 'terminal') {
            const xterm = await _getXtermModule();
            const id = nextInputId();
            if (xterm.sendComposerWs(command, id)) {
                rememberSend(sentSessionId, id, command);
                const accepted = awaitSocketAccept(targetSession, [id]);
                addPendingMessage(sentSessionId, command, sentAt, { sending: true });
                input.value = "";
                clearSentDraft(targetSession); // the box and its saved draft are empty from now: a reload before the answer must not bring the text back (#10085); a refusal puts it back
                xterm.focusTerminal();
                accepted.then(ok => _settleSocketSend(targetSession, command, sentAt, ok));
                return;
            }
        }
        // A shell: the WebSocket path types it as keystrokes (text, then Enter separately)
        if (!hasAttachments && targetAgentType === 'terminal') {
            const xterm = await _getXtermModule();
            // The server acknowledges the text and the Enter by id (#3276).
            const textId = nextInputId();
            if (xterm.sendTerminalInputWs(command, textId)) {
                const enterId = nextInputId();
                // The box clears now, but the saved draft only once the send is accepted:
                // a gone terminal refuses it and the text comes back (#3218).
                const accepted = awaitSocketAccept(targetSession, [textId, enterId]);
                // Send Enter after delay so bracket paste + tmux processing completes
                setTimeout(() => {
                    if (!xterm.sendTerminalInputWs("\r", enterId)) refuseSocketSends(targetSession.session_id, enterId);
                }, 300);
                addPendingMessage(sentSessionId, command, sentAt, { sending: true });
                input.value = "";
                clearSentDraft(targetSession); // the box and its saved draft are empty from now: a reload before the answer must not bring the text back (#10085); a refusal puts it back
                xterm.focusTerminal();
                accepted.then(ok => _settleSocketSend(targetSession, command, sentAt, ok));
                return;
            }
        }

        // Fall back to POST endpoint. The message shows as Sending until this request's answer: Sent only when it says
        // the message was submitted (#4587; the server waits for a starting agent and confirms the submit). The box
        // is emptied meanwhile, so a second click has nothing to send again, and a refusal puts the text back.
        addPendingMessage(sentSessionId, command, sentAt, { sending: true });
        input.value = "";
        clearSentDraft(targetSession);
        const notSent = () => {
            removePendingMessage(sentSessionId, sentAt);
            // The typed text only: the attachments stay attached until a send of them succeeds.
            if (!input.value && state.currentSession && state.currentSession.session_id === sentSessionId) { input.value = textPart; const k = sessionKey(targetSession); if (k) saveSessionDraft(k, textPart); }
        };
        try {
            const resp = await serverFetch(sessionServer(targetSession), `/api/sessions/live/${encodeURIComponent(targetSessionName)}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command, agent_type: targetAgentType, session_id: sentSessionId }),
            });
            if (!resp.ok) {
                notSent();
                // Plain text naming the server; never the raw response (#3151). The draft stays.
                // Said under the composer (#3218); a gone terminal also marks the agent and offers Restart.
                const { text, code, exited } = await responseError(resp, sessionServer(targetSession), `The message was not sent (HTTP ${resp.status}).`);
                reportSendError(targetSession, text, code, exited);
                console.error("Send failed:", resp.status);
                return;
            }
            const result = await resp.json();
            if (result.held) {
                // The agent waits on a question for the person (#6610): the server holds the message and types it once none is left. It shows in the chat then; no "Sent" now.
                removePendingMessage(sentSessionId, sentAt);
                clearAttachments(targetSession);
                const heldKey = sessionKey(targetSession);
                if (heldKey) saveSessionDraft(heldKey, "");
                if (result.held_id !== undefined && result.held_id !== null) noteHeld(sentSessionId, undefined, command, result.held_id); // the line under the box, with Cancel
                showToast(result.note || "Held until the agent's question is answered.");
            } else if (result.error) {
                notSent();
                showComposerError(result.error);
                console.error("Send error:", result.error);
            } else {
                clearComposerError();
                confirmPendingMessage(sentSessionId, sentAt);
                clearAttachments(targetSession);
                const key = sessionKey(targetSession);
                if (key) saveSessionDraft(key, "");
                showToast(sentToastText(command), false, 4000, { silent: true }); // the send status says "Message sent": the toast is for the eyes
                _getXtermModule().then(m => m.focusTerminal());
            }
        } catch (e) {
            notSent();
            showComposerError("The message was not sent. Check the connection and try again.");
            console.error("Send exception:", e);
        }
    } finally {
        _isSending = false;
    }
}

/** The message just sent is no longer a draft: the saved text goes with the box (#10085). */
function clearSentDraft(session) {
    const key = sessionKey(session);
    if (key) saveSessionDraft(key, "");
}

/** A composer send over the terminal socket was accepted or refused (#3218). */
function _settleSocketSend(session, command, sentAt, ok) {
    const key = sessionKey(session);
    const saved = (key && state.sessionInputText[key]) || "";
    const input = document.getElementById("command-input");
    const onIt = !!(input && state.currentSession && sessionKey(state.currentSession) === key);
    if (ok) {
        confirmPendingMessage(session.session_id, sentAt);
        // Text typed since the send is a new draft and stays.
        if (key && saved.trim() === command) saveSessionDraft(key, "");
        showToast(sentToastText(command), false, 4000, { silent: true }); // the send status says "Message sent": the toast is for the eyes
        return;
    }
    removePendingMessage(session.session_id, sentAt);
    if (key && !saved.trim()) saveSessionDraft(key, command);
    if (onIt && !input.value) input.value = command;
}

const DEFAULT_TEAM_REMINDER_ORCHESTRATOR = "Remember to coordinate with your team and check the message board for updates";
const DEFAULT_TEAM_REMINDER_WORKER = "Remember to work with your team";

function _isOrchestratorSession(session) {
    if (!session) return false;
    const name = (session.display_name || "").toLowerCase();
    const title = (session.board_job_title || "").toLowerCase();
    return name.includes("orchestrator") || title.includes("orchestrator");
}

export async function sendCommandWithTeam() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }

    if (sleepingBlocked() || await hubBlocked(state.currentSession)) return; // before the reminder is added to the draft
    const input = document.getElementById("command-input");
    const s = state.settings || {};
    const isOrch = _isOrchestratorSession(state.currentSession);
    const reminder = isOrch
        ? (s.team_reminder_orchestrator || DEFAULT_TEAM_REMINDER_ORCHESTRATOR)
        : (s.team_reminder_worker || DEFAULT_TEAM_REMINDER_WORKER);

    const current = input.value.trim();
    input.value = current ? `${current}\n\n${reminder}` : reminder;
    await sendCommand();
}

const BOARD_PROTOCOL = `You have access to a shared message board for team communication. Use these commands:

- coral-board post "<message>" [--to "agent1,agent2"] — Post a message (--to auto-prepends @mentions)
- coral-board read — Read recent messages
- coral-board read --all — Read all messages

Guidelines:
- Post status updates so the team knows what you're working on
- When you have a new message, Coral will notify you
- Keep messages concise and actionable
- When done with a task, post your results to the board`;

export async function sendBoardProtocol() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }
    if (sleepingBlocked() || await hubBlocked(state.currentSession)) return; // before the protocol is added to the draft
    const input = document.getElementById("command-input");
    const current = input.value.trim();
    input.value = current ? `${current}\n\n${BOARD_PROTOCOL}` : BOARD_PROTOCOL;
    await sendCommand();
}

export async function resendInputPrompt() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }
    if (sleepingBlocked() || await hubBlocked(state.currentSession)) return; // before the prompt replaces the draft
    const s = state.currentSession;
    const boardName = s.board_project || "";
    if (!boardName) {
        showToast("No board found for this session", true);
        return;
    }
    const isOrch = _isOrchestratorSession(s);
    let defaults = {};
    try {
        const res = await fetch("/api/settings/default-prompts");
        defaults = await res.json();
    } catch { /* use fallbacks below */ }
    const settings = state.settings || {};
    const promptTemplate = isOrch
        ? (settings.default_prompt_orchestrator || defaults.default_prompt_orchestrator || "")
        : (settings.default_prompt_worker || defaults.default_prompt_worker || "");
    if (!promptTemplate) {
        showToast("No default prompt configured", true);
        return;
    }
    const prompt = promptTemplate.replace(/\{board_name\}/g, boardName);
    const input = document.getElementById("command-input");
    input.value = prompt;
    await sendCommand();
}

const DEFAULT_MACROS = [
    { label: "🎨 Icon", command: "Pick an emoji that represents your role and set it with: coral-agent-icon set <emoji>" },
];

export function getMacros() {
    const raw = state.settings.macros;
    if (raw) {
        try { return JSON.parse(raw); } catch (e) { /* fall through */ }
    }
    return [...DEFAULT_MACROS];
}

// Macros are one list in one setting: a change is applied to the list the server has NOW (#4423), so a macro another tab
// added is kept, and a delete removes the macro the person clicked, not whatever is at that position now.
async function changeMacros(change) {
    try {
        const { raw } = await updateSettingList("macros", change, { fallback: DEFAULT_MACROS, local: getMacros() });
        state.settings.macros = raw;
    } catch (e) {
        console.error("Failed to save macros:", e);
    }
}

export async function executeMacro(command) {
    // Support chained commands with "&&" separator (1s delay between each)
    if (sleepingBlocked() || await hubBlocked(state.currentSession)) return; // keep the draft
    const parts = command.split("&&").map(c => c.trim()).filter(Boolean);
    if (parts.length === 0) return;
    document.getElementById("command-input").value = parts[0];
    sendCommand();
    for (let i = 1; i < parts.length; i++) {
        setTimeout(() => {
            document.getElementById("command-input").value = parts[i];
            sendCommand();
        }, i * 1000);
    }
}

let macroForm = null; // the Add Macro form (settings_view in form mode), drawn the first time the dialog opens
function macroView() {
    if (macroForm) return macroForm;
    document.getElementById("macro-footer").replaceChildren();
    macroForm = mountSettingsView(document.getElementById("macro-form"), {
        mode: 'form',
        fields: [
            { key: 'label', type: 'text', id: 'macro-label-input', label: 'Label', required: true, placeholder: 'e.g. Commit & Push' },
            { key: 'command', type: 'text', id: 'macro-command-input', label: 'Command', required: true, placeholder: 'e.g. /commit && git push', help: 'Use && to chain several commands (1 second between each).' },
        ],
        form: {
            submit: 'Add', cancel: 'Cancel', barHost: document.getElementById("macro-footer"),
            onSubmit: async values => {
                await changeMacros(list => [...list, { label: values.label.trim(), command: values.command.trim() }]);
                hideMacroModal();
                renderQuickActions();
            },
            onCancel: () => hideMacroModal(),
        },
    });
    return macroForm;
}

export async function deleteMacro(index) {
    const target = getMacros()[index];
    if (!target) return;
    await changeMacros(list => removeFirst(list, m => m && m.label === target.label && m.command === target.command));
    renderQuickActions();
}

export function showMacroModal() {
    const view = macroView();
    view.cancel(); // empty fields, no errors, an empty line
    document.getElementById("macro-modal").style.display = "flex";
    document.getElementById("macro-label-input").focus();
}

export function hideMacroModal() {
    document.getElementById("macro-modal").style.display = "none";
}

export function renderQuickActions() {
    const toolbar = document.getElementById("command-toolbar");
    const macros = getMacros();

    const modeInfo = _modeLabelInfo();
    const modeButtons = `
        <button class="btn btn-quiet btn-small btn-nav btn-mode" id="btn-mode-toggle" data-on-click="cmd-mode-toggle" data-tooltip="${escapeAttr(modeInfo.tooltip)}" aria-label="${escapeAttr(modeInfo.aria)}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/><line x1="6" y1="11" x2="8" y2="11"/></svg><span class="btn-label">${escapeHtml(modeInfo.label)}</span></button>
        <button class="btn btn-quiet btn-small btn-nav btn-mode" data-on-click="cmd-quick" data-cmd="!" aria-label="Bash command" data-tooltip="Prefixes your input with ! so Claude runs it as a shell command instead of a prompt."><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><polyline points="4 7 6 9 4 11"/><line x1="8" y1="11" x2="12" y2="11"/></svg><span class="btn-label">Bash</span></button>
        <button class="btn btn-quiet btn-small btn-nav btn-mode" data-on-click="cmd-raw-keys" data-keys="Escape,Escape" aria-label="Undo" data-tooltip="Sends two Escape keys to Claude. Interrupts the current response, rejects a pending tool call, or backs out of a permission prompt."><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v4h4"/><path d="M3.5 6A5.5 5.5 0 1 1 2.5 8"/></svg><span class="btn-label">Undo</span></button>
    `;

    const macroButtons = macros.map((m, i) => {
        const cls = m.danger ? "btn btn-quiet btn-small btn-nav btn-danger" : "btn btn-quiet btn-small btn-nav";
        return `<span class="macro-btn-wrap">
            <button class="${escapeAttr(cls)}" data-on-click="cmd-macro" data-index="${Number(i)}" data-tooltip="${escapeAttr(m.command)}">${escapeHtml(m.label)}</button>
            <button class="btn btn-quiet btn-icon btn-xs btn-danger macro-delete-btn" data-on-click="macro-delete" data-index="${Number(i)}" title="Remove macro">&times;</button>
        </span>`;
    }).join("");

    const navButtons = `
        <button class="btn btn-quiet btn-small btn-nav btn-esc" data-on-click="cmd-raw-keys" data-keys="Escape" title="Stop — sends Escape to interrupt the agent or dismiss its prompt" aria-label="Stop (Escape)"><span class="esc-label-terminal" aria-hidden="true">Esc</span><span class="esc-label-chat" aria-hidden="true"><span class="material-icons" aria-hidden="true">stop</span></span></button>
        <button class="btn btn-quiet btn-small btn-nav btn-nav-key" data-on-click="cmd-raw-keys" data-keys="Up" title="Arrow Up" aria-label="Arrow Up">&uarr;</button>
        <button class="btn btn-quiet btn-small btn-nav btn-nav-key" data-on-click="cmd-raw-keys" data-keys="Down" title="Arrow Down" aria-label="Arrow Down">&darr;</button>
        <button class="btn btn-quiet btn-small btn-nav btn-enter btn-nav-key" data-on-click="cmd-raw-keys" data-keys="Enter" data-tooltip="Sends an Enter keypress to the terminal" aria-label="Enter">&#9166;</button>
    `;

    const chipBar = document.getElementById("model-chip-bar"); // the toolbar's first item (model_chip.js owns it): kept, with its listeners, across the rebuild
    toolbar.innerHTML = `
        <div class="toolbar-group toolbar-group-modes">
            ${modeButtons}
        </div>
        <span class="toolbar-divider"></span>
        <div class="toolbar-group toolbar-group-macros">
            ${macroButtons}
            <button class="btn btn-quiet btn-icon btn-small btn-nav btn-add-macro" data-on-click="macro-show" title="Add macro" aria-label="Add macro">+</button>
        </div>
        <span class="toolbar-spacer"></span>
        <div class="toolbar-group toolbar-group-nav">
            ${navButtons}
            <div class="toolbar-send-split">
                <button class="btn btn-primary btn-small btn-nav btn-send" data-on-click="cmd-send" data-tooltip="Sends the text from the input box below to the terminal" aria-label="Send command"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
                <button class="btn btn-primary btn-icon btn-small btn-nav btn-send-dropdown" data-on-click="cmd-send-menu" aria-label="Send options" title="Send options" aria-haspopup="menu" aria-expanded="false">
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4z"/></svg>
                </button>
                <div class="menu send-btn-menu" role="menu" aria-label="Send options" style="display:none">
                    <button class="menu-item send-menu-item" role="menuitem" data-on-click="send-menu-send">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                        Send
                        <span class="send-menu-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
                    </button>
                    <button class="menu-item send-menu-item" role="menuitem" data-on-click="send-menu-team">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M17 11a4 4 0 0 1 4 4v2"/></svg>
                        Send + Team Reminder
                    </button>
                    <button class="menu-item send-menu-item" role="menuitem" data-on-click="send-menu-resend">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        Resend Prompt
                    </button>
                    <button class="menu-item send-menu-item" role="menuitem" data-on-click="send-menu-protocol">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></svg>
                        Send Board Protocol
                    </button>
                </div>
            </div>
        </div>
    `;
    if (chipBar) toolbar.prepend(chipBar);
    syncSendStarting(); // the new Send button has its own words: a starting agent's say why a message waits (#6382)
}

// Map tmux key names to raw terminal sequences for WebSocket input

/** Sends the keys; resolves to whether they were sent (false when blocked or refused: sleeping, a Hub block, a pop-out, a refusal, no connection). */
export async function sendRawKeys(keys, { silent = false } = {}) {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return false;
    }
    if (sleepingBlocked(silent)) return false;
    if (await hubBlocked(state.currentSession, { silent })) return false;
    if (popoutTerminalBlocked()) {
        if (!silent) showToast("Agent is not ready to receive input", true);
        return false;
    }
    claimOwnership();

    // Try WebSocket path first — much faster than POST
    const xterm = await _getXtermModule();
    const allMapped = keys.every(rawKeyOk);
    if (allMapped && xterm.sendTerminalInputWs) {
        const seq = keys.map(rawKeySeq).join("");
        if (xterm.sendTerminalInputWs(seq)) {
            if (!silent) showToast(`Sent: ${keys.join(" + ")}`);
            return true;
        }
    }

    // Fall back to POST endpoint for unmapped keys or when WebSocket is unavailable
    try {
        const resp = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keys, agent_type: state.currentSession.agent_type, session_id: state.currentSession.session_id }),
        });
        if (!resp.ok) {
            const { text, code } = await responseError(resp, currentServer(), `The keys were not sent (HTTP ${resp.status}).`);
            reportSendError(state.currentSession, text, code);
            return false;
        }
        const result = await resp.json();
        if (result.error) {
            showComposerError(result.error);
            return false;
        } else {
            clearComposerError();
            if (!silent) showToast(`Sent: ${keys.join(" + ")}`);
            return true;
        }
    } catch (e) {
        showComposerError("The keys were not sent. Check the connection and try again.");
        console.error("sendRawKeys exception:", e);
        return false;
    }
}

export async function killSession() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }

    const cur = state.currentSession;
    const who = agentWords(cur, resolveSessionIdentity(cur)).label; // the agent by its role and team, not the folder it works in (#10139)
    window.showConfirmModal('Kill session', `Kill ${who}? This will terminate the agent. ${WHAT_STAYS_KILL} ${cur.git_state && cur.git_state.is_worktree ? worktreeConfirmWords(cur.branch) + ' ' : ''}${KILL_LOG_NOTE}`, async () => {
        try {
            const killed = state.currentSession;
            const result = await killLiveSession(killed, currentServer());
            if (!result) throw new Error("the kill answer was not JSON");
            if (result.error) {
                showToast(result.error, true);
            } else {
                if (result.changes_artifact_error) {
                    showToast(`Killed, but changes.diff could not be saved: ${result.changes_artifact_error}`, true);
                } else {
                    showToast(`Killed and saved changes.diff: ${agentWords(killed, resolveSessionIdentity(killed)).label}`);
                }
                showWorktreeNotice(result.worktree, 'agent'); // what became of its worktree, if it had one (#6707); a kept one stays on screen with its path (#6818)
                // The row goes at once; the agent's chat stays in History.
                dropKilledRows([{ session_id: killed.session_id, server: currentServer() }]);
                state.currentSession = null;
                showView("welcome-screen");
            }
        } catch (e) {
            showToast("Failed to kill session", true);
            console.error("killSession exception:", e);
        }
    }, undefined, { label: 'Kill session', danger: true });
}

// ── Goal editing ───────────────────────────────────────────────────────────

export function editGoal() {
    const el = document.getElementById("session-summary");
    if (!el) return;
    const textEl = el.querySelector(".summary-text");
    const actionBtns = el.querySelectorAll(".goal-action-btn");
    const currentText = textEl.textContent || "";

    // Replace text span and buttons with an input
    const input = document.createElement("input");
    input.type = "text";
    input.className = "field field-dense goal-edit-input";
    input.value = currentText;

    textEl.style.display = "none";
    actionBtns.forEach(b => b.style.display = "none");
    el.appendChild(input);
    input.focus();
    input.select();

    const commit = async () => {
        const newGoal = input.value.trim();
        input.remove();
        textEl.style.display = "";
        actionBtns.forEach(b => b.style.display = "");

        if (!newGoal || newGoal === currentText) return;

        textEl.textContent = newGoal;

        // Post a goal event to persist the change
        if (state.currentSession && state.currentSession.type === "live") {
            try {
                await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/events`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        event_type: "goal",
                        summary: newGoal,
                        session_id: state.currentSession.session_id,
                    }),
                });
            } catch (e) {
                console.error("Failed to save goal:", e);
            }
        }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = currentText; input.blur(); }
    });
}

export function refreshGoal() {
    if (!state.currentSession || state.currentSession.type !== "live") return;
    const s = state.currentSession;
    requestGoal(s.name, s.agent_type, s.session_id);
}

// Asks the server's goal generator for a fresh goal line. It reads the
// agent's transcript in the background; nothing is typed into the agent's
// terminal. The new goal arrives on the normal session updates.
export function requestGoal(name, agentType, sessionId) {
    serverFetch(serverForSession(name, sessionId), `/api/sessions/live/${encodeURIComponent(name)}/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_type: agentType, session_id: sessionId }),
    }).then(async (resp) => {
        if (resp.ok) {
            showToast("Updating goal…");
            return;
        }
        const data = await resp.json().catch(() => ({}));
        showToast(data.error || "Failed to update goal", true);
    }).catch(() => {
        showToast("Failed to update goal", true);
    });
}

/** The mode the CLI's own mode line shows now, or null when there is no mode line to read (nothing captured, a non-Claude session, a screen not at the prompt). This is the ONLY thing key presses are counted from. */
function detectFooterMode() {
    if (state.currentSession?.agent_type === "terminal") return null;
    const el = document.getElementById("pane-capture");
    if (el?.dataset.captureState === "error") return null;
    return modeFromFooterText(el?.textContent);
}

/** The hook's mode (live_permission_mode: Claude's permission_mode, kept by the server), as a key of MODES, or null. It is the AGENT's own report: it is shown as a label, never trusted to count key presses. */
function reportedMode() {
    if (state.currentSession?.agent_type === "terminal") return null;
    const sig = state.currentSession?.live_permission_mode;
    return typeof sig === "string" && Object.prototype.hasOwnProperty.call(MODES, sig) ? sig : null;
}

/**
 * The mode for the button's LABEL: the screen's mode line (the status line NOW; Shift+Tab at an idle prompt sends no hook event, so the hook's mode is as of the last event), else the mode the
 * agent reported (flagged `reported`). { mode: key|null, reported: boolean }. Never a guess: no mode line and no report is unknown.
 */
function detectLabelMode() {
    const footer = detectFooterMode();
    if (footer) return { mode: footer, reported: false };
    const rep = reportedMode();
    return rep ? { mode: rep, reported: true } : { mode: null, reported: false };
}

function _modeLabelInfo() {
    const { mode: current, reported } = detectLabelMode();
    if (!current) {
        return {
            label: "Mode",
            tooltip: "Cycles Claude's permission mode (Shift+Tab). Each click advances one step.",
            aria: "Mode: unknown. Click to cycle Claude's permission mode (Shift+Tab).",
        };
    }
    const m = MODES[current];
    // A mode the agent reported is a label only: the next step is not named from it (the screen's own mode line is what a click is counted from).
    const next = !reported && m.next ? MODES[m.next].label : "";
    const tail = next ? `Click to switch to ${next} (Shift+Tab).` : "Click for the next mode (Shift+Tab).";
    // Claude calls its starting mode Manual; Coral's Settings and launch form call the same mode Default: the tooltip and the name say so once
    const who = (reported ? " (reported by the agent)" : "") + (current === "default" ? " (Default in Settings)" : "");
    return { label: m.short, tooltip: `Current: ${m.label}${who}. ${tail}`, aria: `Mode: ${m.label}${who}. ${tail}` };
}

/** Sync the Mode quick-action label/tooltip with the terminal buffer. */
function refreshModeLabel() {
    const btn = document.getElementById("btn-mode-toggle");
    if (!btn) return;
    const info = _modeLabelInfo();
    const labelEl = btn.querySelector(".btn-label");
    if (labelEl && labelEl.textContent !== info.label) labelEl.textContent = info.label;
    if (btn.getAttribute("data-tooltip") !== info.tooltip) btn.setAttribute("data-tooltip", info.tooltip);
    if (btn.getAttribute("aria-label") !== info.aria) btn.setAttribute("aria-label", info.aria);
}

// Re-read the mode every time the terminal buffer is rescanned (capture poll
// or initial pane detail), so Shift+Tab pressed directly in the terminal is
// reflected in the button, not only clicks on it.
if (typeof document !== "undefined") {
    document.addEventListener("coral:terminal-updated", refreshModeLabel);
}

export function sendModeToggle(targetMode) {
    // Presses are counted ONLY from the mode line on the screen: the agent's own report can be wrong (or forged), and a wrong start would land on a more permissive mode than the person chose.
    const current = detectFooterMode();
    if (!current) {
        // no mode line to count from: one step, then the footer says where it landed and the person chooses again
        showToast("Stepping one mode: check the mode line, then choose again");
        sendRawKeys(["BTab"], { silent: true });
        return;
    }
    if (current === targetMode) {
        showToast(`Already in ${MODES[targetMode] ? MODES[targetMode].label : "that"} mode`);
        return;
    }
    // Only the steps that hold in every session can be counted ahead (Default, Accept edits, Plan); from or to another mode the Mode button steps one at a time and the footer says where it is.
    const presses = pressesFor(current, targetMode);
    if (presses === null) { showToast("Use the Mode button to step to that mode"); return; }

    const keys = Array(presses).fill("BTab");
    sendRawKeys(keys);
}

export function cycleModeToggle() {
    // One press, whatever the label says; the next mode is named only from the screen's mode line, never from the agent's report.
    const m = MODES[detectFooterMode() || ""];
    showToast(m && m.next ? `Switching to ${MODES[m.next].label} mode` : "Switching to the next mode");
    sendRawKeys(["BTab"], { silent: true });
}

export async function sendQuickCommand(command) {
    if (sleepingBlocked() || await hubBlocked(state.currentSession)) return; // keep the draft
    document.getElementById("command-input").value = command;
    sendCommand();
}

// ── Image Drag & Drop ──────────────────────────────────────────────────────

/** Moves the highlight between live agents by touching the two rows that change (the one that was active, the one that is now), not by drawing every row again
 *  (#4990: a switch cost a full list render, about 10 ms at 4x and the browser's style and layout for every row). A row's markup depends on the selection in
 *  two ways only, its `active` class and aria-current, and the collapsed rail's tile has the same class, so those are what move. False when it cannot be
 *  done here (a team or a history entry is selected, or the new agent has no row yet): the list is then drawn as before. */
function moveActiveRow() {
    const cur = state.currentSession;
    if (state.selectedTeam || !cur || cur.type !== "live" || !cur.session_id) return false;
    const list = document.getElementById("live-sessions-list") || document.getElementById("mobile-session-list");
    const sid = cur.session_id;
    const next = list && list.querySelector(`li.session-group-item[data-session-id="${CSS.escape(sid)}"]`);
    if (!next) return false;
    for (const li of document.querySelectorAll(".session-list li.active")) {
        if (li === next) continue;
        li.classList.remove("active", "list-row-current"); // the class that draws the highlight goes with it (#10273)
        li.removeAttribute("aria-current");
    }
    if (!next.classList.contains("active") || !next.classList.contains("list-row-current")) { next.classList.add("active", "list-row-current"); next.setAttribute("aria-current", "true"); }
    for (const tile of document.querySelectorAll("#sidebar-rail .sidebar-rail-item")) tile.classList.toggle("active", tile.dataset.sessionId === sid);
    return true;
}

export function updateSidebarActive() {
    if (moveActiveRow()) {
        // a history entry that was highlighted is not any more
        document.querySelectorAll("#history-sessions-list li.active").forEach(li => setRowCurrent(li, false));
        return;
    }
    document.querySelectorAll(".session-list li").forEach(li => setRowCurrent(li, false));
    if (state.liveSessions.length) renderLiveSessions(state.liveSessions);

    // Highlight the active history session: its row carries the session id (data-session-id)
    if (state.currentSession && state.currentSession.type === "history") {
        const sid = state.currentSession.name;
        document.querySelectorAll("#history-sessions-list li").forEach(li => {
            if ((li.dataset.sessionId || "") === sid) setRowCurrent(li, true);
        });
    }
}

// The command pane's toolbar, send menu and attachments (#3645): data-on-* names, never code. Keys
// and the quick command come from allowlists; a macro runs by its index in the saved list, so its
// command never sits in an attribute; an index is checked (a bad one does nothing).
const indexOf = v => (v === '0' ? 0 : idOf(v));
registerActions({
    'cmd-mode-toggle': () => cycleModeToggle(),
    'cmd-quick': el => { if (el.dataset.cmd === '!') sendQuickCommand('!'); },
    'cmd-raw-keys': el => {
        const keys = String(el.dataset.keys || '').split(',');
        if (keys.length && keys.length <= 4 && keys.every(rawKeyOk)) sendRawKeys(keys);
    },
    'cmd-macro': el => {
        const i = indexOf(el.dataset.index), m = i === null ? null : getMacros()[i];
        if (m) executeMacro(m.command);
    },
    'macro-delete': el => { const i = indexOf(el.dataset.index); if (i !== null) deleteMacro(i); },
    'macro-show': () => showMacroModal(),
    'cmd-send': () => sendCommand({ nudge: true }),
    'attach-image': () => openImagePicker(),
    'cmd-send-menu': (el, event) => window.toggleSendMenu(el, event),
    'send-menu-send': () => { sendCommand({ nudge: true }); window.closeSendMenu(); },
    'send-menu-team': () => { sendCommandWithTeam(); window.closeSendMenu(); },
    'send-menu-options': () => { window.closeSendMenu(); setTimeout(() => document.getElementById('options-chip')?.click(), 0); }, // after this click has passed the outside-click handlers that would close the sheet at once, // under 640 px the Model and thinking chip is not drawn: the chevron's menu opens its sheet (#9021)
    'send-menu-keys': () => { window.closeSendMenu(); setTimeout(() => document.getElementById('keys-chip')?.click(), 0); }, // and the terminal's Keys
    'send-menu-resend': () => { resendInputPrompt(); window.closeSendMenu(); },
    'send-menu-protocol': () => { sendBoardProtocol(); window.closeSendMenu(); },
    'attachment-open': el => { const i = indexOf(el.dataset.index); if (i !== null) openAttachment(i); },
    'attachment-remove': el => { const i = indexOf(el.dataset.index); if (i !== null) removeAttachment(i); },
});
