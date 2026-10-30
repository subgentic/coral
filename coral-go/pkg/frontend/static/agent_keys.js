/* The agent's keys and Stop on a phone's chat (#6802, design #6795, UI Accessibility's conditions on it). Three things, all for a person at Interact or above (a viewer's composer is `.hub-view-only`: none of
 * this shows there, and the server refuses a viewer's keys anyway):
 *  - Stop: while the agent works and the message box is empty (no words, no pictures) the round Send button is a red rounded square, "Stop the agent". It sends Escape (the CLI's interrupt; Ctrl-C quits the
 *    Claude CLI on a second press), once: it is aria-disabled (still focusable) until the agent's state changes or 3 s pass. Typing a word turns it back into Send.
 *  - The Keys chip (aria-pressed) shows and hides the terminal's own key bar (Esc, Tab, Ctrl-C, the arrows, Enter, | ~ / -, #terminal-key-bar) under the terminal: one key area, in the Terminal view only (#8745). It is closed on every visit until the person opens it; what they chose (open or closed) is kept in this browser and used on every visit.
 *  - A question or menu (the needs-input state) opens the strip by itself, once per question, unless the person closed it for that question or turned the strip off; when the question is answered it closes again only if it opened itself.
 * Everything the screen reader hears goes through #agent-keys-status, a region that is in the page from the start. The key taps themselves say "Sent: Escape" through the toast (the Notifications regions). */
import { deriveSessionState } from './session_state.js';
import { isPhoneLayout } from './phone_layout.js';
import { registerActions } from './actions.js';
import { setAttr, setText } from './dom_write.js';
import { sendRawKeys } from './controls.js';
import { browserLocal } from './safe_storage.js';
import { setTerminalKeysOpen } from './terminal_statusbar.js';
import { cancelHeldForStop, hasHeldForStop, forgetSendGrace } from './held_sends.js';

const $ = id => document.getElementById(id);
const STOP_AGAIN_MS = 3000;
const MIN_ROOM_PX = 40; // two lines of the terminal: below it with the keyboard up the key bar closes itself (a phone turned sideways keeps its bar with the keyboard up: the top bar steps aside once the terminal has focus)

let open = false;            // the strip is showing
let openedBy = null;         // byChip | byQuestion
let closedFor = null;        // the question the person (or the lack of room) closed it for
let sessionId = null;        // the agent this state is for
let away = true;             // the chat was off screen at the last look: the next look is a new visit
let stopShown = false;
let stopHeldUntil = 0;
let stopTimer = 0;
let last = null;             // the latest row of the open agent

// the person's own choice, kept in this browser: 'on' opens the strip on every visit, 'off' keeps it shut (a question does not open it either); unset is the default below
const PREF_KEY = 'coral-agent-keys';
const readPref = () => { const v = browserLocal.get(PREF_KEY); return v === 'on' || v === 'off' ? v : ''; };
const writePref = v => browserLocal.set(PREF_KEY, v);

const say = text => {
    const r = $('agent-keys-status');
    if (!r) return;
    setText(r, '');
    requestAnimationFrame(() => setText(r, text)); // cleared first: the same words said twice are heard twice
};

/** Whether the open agent's chat shows its question card (a role=alert that announces the question). */
const questionCardShown = () => [...document.querySelectorAll('#live-history-messages > .chat-needs-input')].some(e => e.getClientRects().length > 0);

/** The question the agent is asking now, as a key (a different question is a different key), or '' when it is not asking one a person answers with keys (a sign-in is answered in its terminal). */
function questionKey(row) {
    if (!row || deriveSessionState(row) !== 'needs_input' || row.waiting_kind === 'login') return '';
    return `${row.session_id || ''}|${row.waiting_kind || ''}|${row.waiting_summary || ''}`;
}

/** Whether Send is Stop now: the agent works, the box is empty, and this is a phone's layout for a person who may send. */
function stopWanted({ working, text, pictures, viewOnly, phone }) {
    return !!working && !!phone && !viewOnly && !String(text || '').trim() && !pictures;
}

function paintStrip() {
    const strip = $('terminal-key-bar'), chip = $('keys-chip');
    if (!strip || !chip) return;
    setTerminalKeysOpen(open);
    setAttr(chip, 'aria-pressed', String(open));
}

function openStrip(by, words) {
    if (open) return;
    open = true; openedBy = by; paintStrip();
    if (words) say(words);
}

function closeStrip(words, { forQuestion = false } = {}) {
    if (!open) return;
    const strip = $('terminal-key-bar'), box = $('command-input');
    if (strip && strip.contains(document.activeElement) && box) box.focus(); // never to the page
    open = false; openedBy = null; paintStrip();
    if (forQuestion && last) closedFor = questionKey(last) || closedFor;
    if (words) say(words);
}

/** Whether the agent can be stopped from the box now: it works, the box is empty, for a person who may send (any layout, #10085). */
function stopNowWanted({ working, text, pictures, viewOnly }) {
    return !!working && !viewOnly && !String(text || '').trim() && !pictures;
}
let stopNow = false;
let escHeldUntil = 0;
let stoppingTimer = 0;
const STOPPING_MAX_MS = 15000;
/** Stop was pressed (any of its three ways): the button greys and says "Stopping…" at once, and goes back when the agent is not working (said aloud: "The agent stopped"), or after a while if it still is (said too). */
function markStopping() {
    const pane = $('command-pane');
    if (!pane || pane.getAttribute('data-stopping') === 'true') return;
    pane.setAttribute('data-stopping', 'true');
    const b = $('mobile-send-btn'); if (b && b.classList.contains('is-stop')) setAttr(b, 'aria-label', 'Stopping the agent');
    clearTimeout(stoppingTimer);
    stoppingTimer = setTimeout(() => endStopping('The agent is still working'), STOPPING_MAX_MS); // timeout-ok: the escape hatch if the agent never reports it stopped
}
function endStopping(words) {
    clearTimeout(stoppingTimer);
    const pane = $('command-pane');
    if (!pane || pane.getAttribute('data-stopping') !== 'true') return;
    pane.removeAttribute('data-stopping');
    const b = $('mobile-send-btn'); if (b && b.classList.contains('is-stop')) setAttr(b, 'aria-label', 'Stop the agent');
    if (words) say(words);
}
/** A desktop's chat has its Stop in the toolbar (the ■): it turns red and says Stop while stopNow, and Escape in the empty box presses it. */
function paintStopNow(want) {
    stopNow = want;
    if (want) wireStopClick();
    setAttr($('command-pane'), 'data-stop-now', String(want));
}

function paintStop(want) {
    const btn = $('mobile-send-btn');
    if (!btn) return;
    if (want === stopShown) return;
    stopShown = want;
    btn.classList.toggle('is-stop', want);
    if (want) btn.setAttribute('data-on-click', 'cmd-stop'); else btn.setAttribute('data-on-click', 'cmd-send'); // literal names: the action census reads them
    setAttr(btn, 'aria-label', want ? 'Stop the agent' : 'Send');
    if (!want) { btn.removeAttribute('aria-disabled'); stopHeldUntil = 0; }
    else if (document.activeElement === $('command-input')) say('Stop is shown'); // said to a person typing in the composer, not on every turn the agent takes (the button's name carries it otherwise)
}

function inputState() {
    const box = $('command-input');
    return { text: box ? box.value : '', pictures: (document.getElementById('image-attachments') || { childElementCount: 0 }).childElementCount }; // (an id lookup: a selector over the page on every keystroke used the whole per-key budget, perf_budgets)
}

/** Called with the open agent's row each time the page learns of its state (updateWaitingIndicator), and when the box changes. */
export function syncAgentKeys(row) {
    if (row) last = row;
    const r = last;
    const pane = $('command-pane');
    if (!pane || !r) return;
    const visible = pane.checkVisibility && pane.checkVisibility();
    if (!visible) { away = true; return; }
    const id = r.session_id || r.name || null;
    if (away || id !== sessionId) { // a new visit: closed, nothing remembered
        sessionId = id; away = false; open = readPref() === 'on'; openedBy = open ? 'byChip' : null; closedFor = null; paintStrip();
    }
    const viewOnly = pane.classList.contains('hub-view-only');
    if (viewOnly) { open = false; openedBy = null; paintStrip(); }
    const key = deriveSessionState(r);
    const q = questionKey(r);
    if (!viewOnly) {
        if (q && !open && closedFor !== q && readPref() !== 'off') openStrip('byQuestion', questionCardShown() ? '' : 'Keys for the question are shown'); // the card in the chat has said the question: not a third time (#10374)
        else if (!q && open && openedBy === 'byQuestion') closeStrip();
        if (!q) closedFor = null;
    }
    const { text, pictures } = inputState();
    paintStop(stopWanted({ working: key === 'working', text, pictures, viewOnly, phone: isPhoneLayout() }));
    paintStopNow(stopNowWanted({ working: key === 'working', text, pictures, viewOnly }));
    if (key !== 'working') { const note = stoppedNote; stoppedNote = ''; endStopping(note ? `The agent stopped. ${note}` : 'The agent stopped'); }
}

/** Stop: the held messages of this device are dropped first (their text back in the box), then the agent gets its Escape; what happened is said once it is known. Returns false when the Escape was not sent. */
async function stopAgent(silentFail) {
    markStopping();
    const sid = last && last.session_id;
    const back = sid && hasHeldForStop(sid) ? await cancelHeldForStop(sid) : 0;
    const sent = await sendRawKeys(['Escape'], { silent: true });
    if (sent === false) { endStopping(silentFail); return false; }
    forgetSendGrace(sid); // the Escape went: a message just sent is no longer in flight for the Working row (#11052)
    stoppedNote = back ? `${back === 1 ? 'The message' : `${back} messages`} that waited ${back === 1 ? 'was' : 'were'} not sent: back in the box.` : '';
    return true;
}
let stoppedNote = '';

registerActions({
    'agent-keys-toggle': () => {
        if (open) { writePref('off'); closeStrip(undefined, { forQuestion: true }); }
        else { writePref('on'); open = false; openStrip('byChip'); }
    },
    'cmd-stop': async () => {
        const btn = $('mobile-send-btn');
        if (!btn || Date.now() < stopHeldUntil) return; // one press is enough: a second interrupt quits the CLI
        stopHeldUntil = Date.now() + STOP_AGAIN_MS;
        setAttr(btn, 'aria-disabled', 'true');
        clearTimeout(stopTimer);
        stopTimer = setTimeout(() => { if (stopShown) btn.removeAttribute('aria-disabled'); stopHeldUntil = 0; }, STOP_AGAIN_MS); // timeout-ok: the second press is allowed again if nothing changed
        say('Stopping the agent');
        const sent = await stopAgent('Stop was not sent: the agent is not taking input');
        if (sent === false) { // blocked (asleep, a Hub block, a pop-out) or refused: say so, and let the person press again at once
            say('Stop was not sent: the agent is not taking input');
            stopHeldUntil = 0; clearTimeout(stopTimer); btn.removeAttribute('aria-disabled');
        }
    },
});

/** With the keyboard up the strip must not push the output out: under two lines of the terminal it closes itself and says so. */
function checkRoom() {
    if (!open) return;
    const shown = [$('xterm-container'), $('pane-capture')].find(e => e && e.checkVisibility && e.checkVisibility()); // the strip is in the terminal view: the room is the terminal's output
    const h = shown ? shown.clientHeight : 0;
    if (h && h < MIN_ROOM_PX) closeStrip('Keys closed: there is no room for them with the keyboard up', { forQuestion: true });
}

if (typeof document !== 'undefined') {
    const wire = () => {
        const strip = $('terminal-key-bar'), chip = $('keys-chip'), btn = $('mobile-send-btn'), box = $('command-input');
        if (!strip || !chip || !btn) return false;
        // a tap on a key, the chip or Stop leaves focus where it is: the on-screen keyboard stays open (a keyboard or switch user still reaches them by Tab and Enter)
        for (const el of [strip, chip, btn]) el.addEventListener('pointerdown', e => { if (e.pointerType === 'touch' || e.pointerType === 'pen') e.preventDefault(); });
        // an aria-disabled Stop does nothing when pressed again
        btn.addEventListener('click', e => { if (btn.getAttribute('aria-disabled') === 'true') { e.stopPropagation(); e.preventDefault(); } }, true);
        if (box) box.addEventListener('input', () => syncAgentKeys());
        window.addEventListener('resize', () => { checkRoom(); });
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { checkRoom(); });
        return true;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true }); else wire();
}

// the desktop toolbar's Stop (the ■) is the Escape key button while it is red: pressing it is a stop. Its page-wide click listener is registered the first time the button turns red, not at startup (#11032).
let stopClickOn = false;
function wireStopClick() {
    if (stopClickOn) return;
    stopClickOn = true;
    document.addEventListener('click', e => {
        if (!stopNow || !e.target || !e.target.closest || !e.target.closest('#command-pane .btn-esc')) return;
        if (Date.now() < escHeldUntil) { e.stopPropagation(); e.preventDefault(); return; } // one is enough: a second interrupt quits the CLI
        escHeldUntil = Date.now() + STOP_AGAIN_MS;
        e.stopPropagation(); e.preventDefault(); // the button's own Escape is sent by stopAgent, after the held messages are dropped
        stopAgent('Stop was not sent: the agent is not taking input');
    }, true);
}

// Escape in the empty message box stops a working agent: what the CLI itself does; a typed message, an open menu or a mention list keep their own Escape.
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!e.target || e.target.id !== 'command-input' || !stopNow) return;
    e.preventDefault();
    if (Date.now() < escHeldUntil) return; // one is enough: a second interrupt quits the CLI
    escHeldUntil = Date.now() + STOP_AGAIN_MS;
    stopAgent('Stop was not sent: the agent is not taking input');
});
