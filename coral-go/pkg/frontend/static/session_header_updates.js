/* Live updates to the open agent's header: its folder, branch, waiting state, goal and status (moved out of render.js, #4996; no behaviour change). */
import { syncWaitingNotice } from './waiting.js'; // what waits for the open agent, with Send now (#7727)
import { syncQueuedFromRow, paint as paintQueued } from './held_sends.js';
import { _shortPath, _gitStateSummary, _repoBranch, presentationSessionState } from './session_state.js';
import { startupSignedOut } from './signin_line.js';
import { syncAgentKeys } from './agent_keys.js';
import { setText, setHidden, setTitle, setHtml, setDisplay, setClassName, setPill } from './dom_write.js';
import { modelName, sessionLevel } from './model_labels.js';
import { sessionServer } from './server_base.js';

export function updateSessionStatus(status) {
    const el = document.getElementById("session-status");
    if (status) {
        setText(el.querySelector(".status-text"), status);
    }
}

// The terminal header shows the git branch; only an agent with no branch
// shows its folder instead (full path on hover).
let _headerDir = "";

let _headerHasBranch = false;

function _syncHeaderFolder() {
    const el = document.getElementById("terminal-header-folder");
    if (!el) return;
    const show = !!_headerDir; // the folder and the branch are both in the header now (the row no longer says either, #9686); the full path is the hover
    setHidden(el, !show);
    if (!show) return;
    setText(el.querySelector(".terminal-folder-text"), _shortPath(_headerDir, 2));
    setTitle(el, _headerDir);
}

/** The model and thinking level in the open agent's header (#9686: the agent row is one line and no longer says them; the composer's chips still change them). Hidden when neither is on record. */
export function updateSessionModel(s) {
    const model = s ? modelName(s.agent_type, s.model, sessionServer(s)) : '';
    const level = s ? sessionLevel(s) : null;
    _details.model = model; _details.thinking = level ? `${level.name}${level.requested ? ' (as started)' : ''}` : '';
    _syncPhoneDetails();
    const el = document.getElementById("terminal-header-model");
    if (!el) return;
    const text = [model, level && level.name].filter(Boolean).join(' \u00b7 ');
    setHidden(el, !text);
    if (!text) return;
    setText(el.querySelector(".terminal-folder-text"), text);
    setTitle(el, [model && `Model ${model}`, level && `Thinking ${level.name}${level.requested ? ' (as started)' : ''}`].filter(Boolean).join(', '));
}

// A phone's Details disclosure (#9686): the four facts the agent row no longer says, one tap away; a row with no value is not drawn, and with none the disclosure is not either.
const _details = { folder: '', branch: '', model: '', thinking: '' };
function _syncPhoneDetails() {
    const box = document.getElementById('agent-phone-details');
    if (!box) return;
    let any = false;
    for (const [key, value] of Object.entries(_details)) {
        const dd = document.getElementById(`apd-${key}`);
        if (!dd) continue;
        setText(dd, value);
        setTitle(dd, key === 'folder' ? value : '');
        setHidden(dd.parentElement, !value);
        any = any || !!value;
    }
    setHidden(box, !any);
}

export function updateSessionFolder(dir) {
    _details.folder = dir || '';
    _syncPhoneDetails();
    _headerDir = dir || "";
    _syncHeaderFolder();
}

export function updateSessionBranch(branch, repoName, gitState) {
    const display = _repoBranch(repoName, branch);
    _details.branch = display || '';
    _syncPhoneDetails();
    const el = document.getElementById("session-branch");
    if (el) {
        if (display) {
            setText(el.querySelector(".branch-text"), display);
            const gsEl = el.querySelector(".branch-git-state");
            if (gsEl) {
                const wt = gitState?.is_worktree ? '<span class="gs-worktree" title="This agent is working in a linked git worktree">worktree</span> ' : '';
                setHtml(gsEl, wt + _gitStateSummary(gitState));
            }
            setDisplay(el, "");
        } else {
            setDisplay(el, "none");
        }
    }
    _headerHasBranch = !!display;
    _syncHeaderFolder();
    // Same info in the terminal header, which has room beside the agent name.
    const th = document.getElementById("terminal-header-branch");
    if (th) {
        setHidden(th, !display);
        if (display) {
            const bt = th.querySelector(".terminal-branch-text");
            setText(bt, display);
            th.dataset.full = display; // the whole name, drawn by the chip's ::after while the text is hovered, focused or tapped (branch_expand.js)
            bt.setAttribute("aria-label", `Branch ${display}`);
            const gs = th.querySelector(".branch-git-state");
            if (gs) {
                const wt = gitState?.is_worktree ? '<span class="gs-worktree" title="This agent is working in a linked git worktree">worktree</span> ' : '';
                setHtml(gs, wt + _gitStateSummary(gitState));
            }
        }
    }
}

export function updateWaitingIndicator(s) {
    syncAgentKeys(s); // Stop in place of Send, and the strip that a question opens (#6802)
    syncWaitingNotice(s);
    syncQueuedFromRow(s); paintQueued(); // the person's own messages held behind a question (#6611)
    const dot = document.getElementById("session-status-dot");
    const banner = document.getElementById("waiting-banner");
    if (dot) {
        const key = presentationSessionState(s);
        dot.classList.toggle("waiting", key === 'needs_input' || key === 'check_terminal');
        dot.classList.toggle("stuck", key === 'stuck');
        dot.classList.toggle("working", key === 'working');
        dot.classList.toggle("your-turn", key === 'your_turn');
        dot.classList.remove("done"); // green no longer means anything
    }
    if (banner) {
        // Two states share this banner. waiting_for_input is a running agent
        // asking a question. not_started is an agent that has never done
        // anything — blocked on a first-run prompt, or simply never given a
        // task; those are indistinguishable from outside the CLI, so the copy
        // claims only what is true of both. We never answer a prompt on the
        // user's behalf: the banner's job is to point at the terminal, where
        // the question is already on screen.
        // Same resolver as the rows: the banner follows the WINNING state, so a
        // sleeping or stuck agent with a stale waiting flag never shows it.
        const bannerKey = presentationSessionState(s);
        // An overlay pill (#5287): no layout space, shown after a delay so a state that comes and goes at once never flashes it, gone at once.
        let text = "";
        if (bannerKey === 'needs_input') {
            setClassName(banner, "notice notice-warn notice-float notice-center notice-compact waiting-banner");
            // The card in the chat says this too (needs_input_card.js), and the pill is hidden while that card is on screen (css, #5895): one message; scrolled away from the card, the pill is the cue
            text = s.waiting_kind === 'login' ? "⏳ Agent needs you to sign in (in its terminal)" : "⏳ Agent is waiting for input";
        } else if (bannerKey === 'check_terminal' && !startupSignedOut(s)) { // signed out: the card says so, once
            setClassName(banner, "notice notice-warn notice-float notice-compact waiting-banner waiting-banner-not-started");
            text = "⏳ This agent hasn't done anything yet. Open its terminal: some agents ask to trust the folder, or to sign in, the first time they run.";
        }
        setPill(banner, !!text, text);
    }
}

export function updateSessionSummary(summary) {
    const el = document.getElementById("session-summary");
    if (!el) return;
    if (summary) {
        setText(el.querySelector(".summary-text"), summary);
        setDisplay(el, "");
    }
    // Don't hide — a null summary from a WebSocket tick shouldn't
    // clear a previously-known goal.
}
