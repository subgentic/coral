/* The empty chat's words and sending a prompt card's answer (moved out of live_chat.js, #5065; no behaviour change; its click and submit listeners stay in live_chat.js, which registers them after its own earlier ones). */
import { state } from './state.js';
import { deriveSessionState } from './render.js';
import { TRAILING_CHROME } from './chat_content.js';
import { showToast } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';
import { responseError } from './server_status.js';
import { reportSendError, noteHooksAnswered } from './terminal_gone.js';
import { announcePrompt, promptOptionsBySession, syncNeedsInputCard } from './needs_input_card.js';
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';

// The first seconds of a new agent (#6058): its CLI has written nothing yet (the list has no output age for it), and it was started less than STARTING_MS ago by the list's created_at AND this page first saw it less than STARTING_MS ago (the second bounds a server clock that runs ahead of this one). "No messages yet" there reads as ready; it says the CLI is coming up.
// After that the row's own states take over (the "Waiting in the terminal" card from 25 s with no event at all).
const STARTING_MS = 25 * 1000;
const firstSeen = new Map(); // session_id -> ms of the first look at its empty chat
function isStarting(row) {
    if (!row || !row.session_id || row.agent_type === "terminal" || row.not_started || row.working || row.waiting_for_input || typeof row.staleness_seconds === "number") return false;
    const startedAt = Date.parse(row.created_at || ""); // the agent's own start: one that has been idle for hours is not starting, whenever this page opens it
    if (Number.isFinite(startedAt) && Date.now() - startedAt >= STARTING_MS) return false;
    if (!firstSeen.has(row.session_id)) firstSeen.set(row.session_id, Date.now());
    return Date.now() - firstSeen.get(row.session_id) < STARTING_MS;
}
const CLI_NAMES = { claude: "Claude", codex: "Codex", pi: "Pi", agy: "Antigravity", antigravity: "Antigravity", gemini: "Antigravity" };

// A new agent's first seconds, counted (#10299, Desktop pass 26: from Launch to a ready message box takes 15 to 60 s, and the chat said nothing that moved, so it looked stuck): while the live list says the CLI has not
// emitted its first event (row.starting, #6381) the chat's title is "Starting Claude... 12 s", counting from the agent's own start; when the row stops saying it, "Ready" for a moment; after 90 s it says what to check.
const CHECK_AFTER_S = 90, READY_MS = 3000;
const readyAt = new Map(); // session_id -> ms when a counted start ended, while the chat is still empty
let startTick = 0, tickContainer = null;
function startedAt(row) {
    const created = Date.parse(row.created_at || "");
    if (Number.isFinite(created) && created <= Date.now() + 5000 && Date.now() - created < 10 * 60 * 1000) return created;
    if (!firstSeen.has(row.session_id)) firstSeen.set(row.session_id, Date.now());
    return firstSeen.get(row.session_id);
}
function countingStart(row) { return !!row && row.starting === true && row.agent_type !== "terminal" && !row.sleeping && !row.not_started; }
/** Redraw the empty chat each second while a start is being counted or its Ready is showing; nothing runs otherwise. */
function tickWhile(container, on) {
    if (!on) { if (startTick) { clearInterval(startTick); startTick = 0; } tickContainer = null; return; }
    tickContainer = container;
    if (!startTick) startTick = setInterval(() => { if (!tickContainer || !tickContainer.isConnected) { tickWhile(null, false); return; } syncEmptyState(tickContainer); }, 1000); // interval-ok: a second-by-second counter that runs only while a start is counted (or its Ready shows) and stops itself; it fetches nothing
}

const MODE_NAMES = { '': 'Auto mode', auto: 'Auto mode', default: 'Default mode', acceptEdits: 'Accept edits mode', plan: 'Plan mode', dontAsk: "Don't ask mode", bypassPermissions: 'Bypass permissions mode' };
// Where the agent works and how it acts, in the words Settings and the New agent footer use for its CLI (#10035, the desktop tester: no hint what this agent can touch): the folder's name, then its permission mode and what that allows for this CLI (Auto is not the same for Claude, Codex, Antigravity, Gemini and Pi, #10000).
let permissionDescription = null; // permission_flags.js is loaded lazily (it carries the settings modules): the first empty chat asks for it, and draws the words again when it is here
function wantWords() { if (!permissionDescription) importOnce('./permission_flags.js').then(m => { permissionDescription = m.permissionDescription; const c = document.getElementById('live-history-messages'); if (c) syncEmptyState(c); }).catch(() => {}); }
function worksIn(row) {
    wantWords();
    const folder = String(row?.working_directory || '').split(/[\\/]/).filter(Boolean).pop();
    const type = String(row?.agent_type || '').toLowerCase(), mode = [row?.live_permission_mode, row?.permission_mode].find(m => typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODE_NAMES, m) && m !== '') || ''; // the CLI's own report (Claude's hook, follows Shift+Tab) first, then what the launch was given; none on record: no claim (a guess of Auto said 'safety checks' of a Default launch, #10253)
    const said = permissionDescription && (mode || type === 'pi') ? permissionDescription(type, mode).replace(/\.$/, '') : ''; // Pi has no permission prompts whatever the mode (its words do not depend on it)
    const name = type === 'codex' && ['', 'auto', 'dontAsk'].includes(mode) ? MODE_NAMES.default : MODE_NAMES[mode]; // Codex's Default, Auto and Don't ask are one launch with one name: Default, which is what its row records (#10381)
    const how = !said ? '' : type === 'pi' || !name ? `${said}.` : `${name}: ${said.charAt(0).toLowerCase()}${said.slice(1)}.`;
    return [folder ? `Working in ${folder}.` : '', how].filter(Boolean).join(' ');
}

// What a brand-new agent's empty chat says, by what the agent is doing: a title, and a hint on what to do next.
function emptyStateWords(session) {
    const row = (state.liveSessions || []).find(s => s.session_id === session?.session_id) || session;
    const cli = CLI_NAMES[row?.agent_type] || "the agent";
    if (countingStart(row) && deriveSessionState(row) === "idle") {
        const secs = Math.max(0, Math.floor((Date.now() - startedAt(row)) / 1000));
        readyAt.set(row.session_id, 0); // a count in progress: its end is Ready
        return secs >= CHECK_AFTER_S
            ? [`Starting ${cli}...`, `Still not ready after ${CHECK_AFTER_S} s. Check that ${cli} is installed and signed in, then open the terminal to see what it says.`, secs]
            : [`Starting ${cli}...`, "Its first screen is not up yet. You can type below once it is.", secs];
    }
    if (row && readyAt.get(row.session_id) === 0) readyAt.set(row.session_id, Date.now()); // the count just ended
    if (row && readyAt.get(row.session_id) > 0 && Date.now() - readyAt.get(row.session_id) < READY_MS && deriveSessionState(row) !== "sleeping") return ["Ready", `${cli} is up. Type below to start.`];
    if (isStarting(row) && deriveSessionState(row) === "idle") return [`Waiting for ${cli} to start`, "Its first screen is not up yet. You can type below once it is."];
    switch (deriveSessionState(row)) {
        case 'sleeping': return row.sleep_reason === 'agent_exited' ? ["This agent has ended", "Its CLI exited. Use Restart below to start it again."] : ["This agent is asleep", "Use Wake below to chat with it."];
        default: return ["Say hello to your agent", [worksIn(row), "Type below to start."].filter(Boolean).join(' ')];
    }
}

// A brand-new agent has no transcript yet; say so, and what to do, instead of a blank pane.
export function syncEmptyState(container) {
    const hasContent = Array.from(container.children).some(c => !c.matches(TRAILING_CHROME + ", .load-more-btn, .loading-indicator"));
    const busy = container.querySelector(":scope > .chat-working, :scope > .chat-needs-input, :scope > .pending-messages");
    let el = container.querySelector(":scope > .chat-empty");
    if (hasContent || busy) {
        if (el) el.remove();
        tickWhile(null, false);
        const count = document.getElementById("composer-starting-count"); if (count && !count.hidden) { count.hidden = true; count.textContent = ""; }
        return;
    }
    const [title, hint, secs] = emptyStateWords(state.currentSession);
    // On a phone the keyboard hides the chat's own count: the same words stand above the message box (#10504); on a desktop the chat's title says it
    const count = document.getElementById("composer-starting-count");
    if (count) {
        const line = secs !== undefined && isPhoneLayout() ? `${title} ${secs} s` : "";
        if (count.textContent !== line) count.textContent = line;
        if (count.hidden === !!line) count.hidden = !line;
    }
    { // one tick a second only while a count or its Ready shows
        const cur = (state.liveSessions || []).find(x => x.session_id === state.currentSession?.session_id) || state.currentSession;
        tickWhile(container, countingStart(cur) || (!!cur && readyAt.get(cur.session_id) > 0 && Date.now() - readyAt.get(cur.session_id) < READY_MS));
    }
    if (!el) {
        el = document.createElement("div");
        el.className = "chat-empty";
        el.setAttribute("role", "status");
        el.innerHTML = '<div class="chat-empty-title"></div><div class="chat-empty-hint"></div>';
        container.appendChild(el);
    }
    // Only write a word that changed, so a screen reader is not told the same thing at every poll
    const t = el.querySelector(".chat-empty-title"), h = el.querySelector(".chat-empty-hint");
    const base = t.firstChild && t.firstChild.nodeType === 3 ? t.firstChild.data : t.textContent;
    if (base !== title) t.textContent = title;
    // the seconds are drawn, not announced: a status region that said a new number each second would talk over everything (#10299)
    let sp = t.querySelector(".chat-empty-secs");
    if (secs === undefined) { if (sp) sp.remove(); } else {
        if (!sp) { sp = document.createElement("span"); sp.className = "chat-empty-secs"; sp.setAttribute("aria-hidden", "true"); t.append(sp); }
        const txt = ` ${secs} s`; if (sp.textContent !== txt) sp.textContent = txt;
    }
    if (h.textContent !== hint) h.textContent = hint;
}

// Answering: the server re-reads the terminal and sends the digit (plus the
// typed text for a text option) only if that option is still on screen with
// this label.
export async function sendPromptAnswer(card, n, label, action, text) {
    const session = state.currentSession;
    if (!session || session.type !== "live") return false;
    const controls = card ? Array.from(card.querySelectorAll(".cni-answer, .cni-text-form button, .cni-text-form input")) : [];
    // A disabled control loses focus: remember which one had it, and put it back (a toggle keeps it) or, when the card goes with the answer, move it to the message box (#5252).
    const hadFocus = card && card.contains(document.activeElement) ? document.activeElement : null;
    controls.forEach(c => { c.disabled = true; });
    const giveFocusBack = (to) => { if (hadFocus && to && to.isConnected) to.focus({ preventScroll: true }); };
    try {
        const resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/answer-prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action === "submit"
                ? { session_id: session.session_id, agent_type: session.agent_type || "", submit: true }
                : { session_id: session.session_id, agent_type: session.agent_type || "", n, label, text: text || "" }),
        });
        if (!resp.ok) {
            const { text, code } = await responseError(resp, sessionServer(session), "Could not send the answer. Use the terminal.");
            reportSendError(session, text, code); // under the composer (#3218)
            controls.forEach(c => { c.disabled = false; });
            giveFocusBack(hadFocus);
            return false;
        }
        if (action === "toggle") {
            // A box of a multi-select question: nothing is answered. The card shows the screen the server
            // read after the toggle (the mark it confirmed), never a mark flipped here (#5232).
            const po = (await resp.json().catch(() => null) || {}).prompt_options;
            if (po) promptOptionsBySession.set(session.session_id, { title: po.title || "", question: po.question || "", options: po.options || [], review: po.review || [], multi: !!po.multi, submit: po.submit || null });
            const container = document.getElementById("live-history-messages");
            if (container) syncNeedsInputCard(container, session);
            controls.forEach(c => { c.disabled = false; });
            giveFocusBack(hadFocus);
            const row = ((po && po.options) || []).find(o => Number(o.n) === n);
            if (row) announcePrompt(`${row.label}, ${row.checked ? "checked" : "not checked"}`);
            return true;
        }
        // The card refreshes from the terminal: the next question, the review
        // step, or gone once the tool runs.
        promptOptionsBySession.delete(session.session_id);
        noteHooksAnswered();
        if (action === "submit") announcePrompt("Answer sent");
        if (action !== "chat") giveFocusBack(document.getElementById("command-input")); // the card goes with its answer: focus goes to the message box
        if (action === "chat") {
            const input = document.getElementById("command-input");
            if (input) input.focus();
            showToast("Type your reply below");
        }
        return true;
    } catch {
        showToast("Could not send the answer. Use the terminal.", true);
        controls.forEach(c => { c.disabled = false; });
        return false;
    }
}
