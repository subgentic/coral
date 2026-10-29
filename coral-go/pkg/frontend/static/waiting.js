/* What waits for an agent (#7727). Coral types an agent's board nudges at once and holds nothing: when a prompt or menu is open, or the input box holds a draft, the text is not typed, and the unread
 * message stays on the board. The agent view says what is there (the row's board_unread and skipped_send), lists it on request (GET /waiting) and has Send now, the Operator's own action: the server
 * types the board nudge into the agent's input box whether or not it is in the middle of a turn, and never into a prompt that is open or over a draft. */
import { registerActions } from './actions.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { serverFetch, currentServer } from './server_base.js';
import { responseErrorText } from './server_status.js';
import { whenText } from './when_text.js';
import { showConfirmModal } from './confirm_dialog.js';

/** A safe non-negative integer from a row's board_unread. */
export function waitingCount(row) {
    const n = Number(row && row.board_unread);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999) : 0;
}

/** { why, what } of the row's last skipped send, or null. Strings only: payloads are untrusted. */
export function skippedOf(row) {
    const k = row && row.skipped_send;
    if (!k || typeof k.why !== 'string' || !k.why) return null;
    return { why: k.why, what: typeof k.what === 'string' ? k.what : '' };
}

/** Whether Coral pauses this agent's board notices because the program in its terminal is not the agent it recorded (#391: since the
 *  notice-target check, an agent that was running before the update is paused until it is recorded, woken or restarted). */
export function noticesPaused(row) {
    const k = skippedOf(row);
    return !!k && /^notices paused\b/i.test(k.why);
}

/** The agent view's line: '' when no board message waits and its notices are not paused (another skipped send alone says nothing here). */
export function waitingText(row) {
    if (!row || row.sleeping) return '';
    const n = waitingCount(row);
    if (n > 0) return `${n} team message${n === 1 ? ' waits' : 's wait'} for this agent`; // short on purpose (#10036): why it waits, the list and the actions are behind Options
    return noticesPaused(row) ? 'Board notices are paused for this agent' : '';
}

/** What is said after a Send now, from the server's answer. */
export function sendNowToast(r) {
    if (r && r.nothing_waiting) return 'No unread team messages wait for this agent.';
    if (r && r.draft_in_box) return 'There is a draft in the agent\'s input box: nothing was sent. Send or clear it first.';
    if (r && r.prompt_open) return 'A prompt is open in the agent\'s terminal: nothing was sent into it. Answer it first.';
    if (r && r.sent) return 'Sent now.';
    return 'Not sent' + (r && typeof r.why === 'string' && r.why ? ': ' + r.why : '.');
}

/** The agent view's one line and its Options link; Send these now, Show terminal and the list are in the panel Options opens. Written only on a change (#5010's budget). */
export function syncWaitingNotice(row) {
    const el = document.getElementById('composer-waiting-notice');
    if (!el) return;
    const text = waitingText(row), on = text !== '';
    const t = document.getElementById('composer-waiting-text');
    if (t && t.textContent !== text) t.textContent = text;
    if (el.classList.contains('composer-waiting-empty') === on) el.classList.toggle('composer-waiting-empty', !on);
    for (const b of el.querySelectorAll('button')) if (b.hidden === on) b.hidden = !on;
    const send = document.getElementById('composer-waiting-send');
    const canSend = on && waitingCount(row) > 0;
    if (send && send.hidden === canSend) send.hidden = !canSend;
    const paused = on && noticesPaused(row); // Record as agent and Record for all agents, the Operator's way to end the pause (#391)
    for (const id of ['composer-waiting-record', 'composer-waiting-record-all']) {
        const b = document.getElementById(id);
        if (b && b.hidden === paused) b.hidden = !paused;
    }
    if (!on) closeList();
}

function closeList() {
    const d = document.getElementById('composer-waiting-detail'), b = document.getElementById('composer-waiting-list');
    if (d && !d.hidden) d.hidden = true;
    if (b && b.getAttribute('aria-expanded') !== 'false') b.setAttribute('aria-expanded', 'false');
}

const url = (s, tail) => `/api/sessions/live/${encodeURIComponent(s.name)}/waiting${tail}`;

function listNode(r) {
    const root = document.createDocumentFragment();
    const k = r && r.skipped;
    if (k && k.why) { // why they wait comes first
        const p = document.createElement('p');
        p.className = 'composer-waiting-why';
        p.textContent = `Not typed: ${String(k.why)}.`;
        root.append(p);
    }
    const ms = Array.isArray(r && r.messages) ? r.messages : [];
    if (!ms.length) { const p = document.createElement('p'); p.textContent = 'No unread board messages.'; root.append(p); }
    for (const m of ms) {
        const d = document.createElement('details');
        const sum = document.createElement('summary');
        const when = document.createElement('time');
        when.dateTime = String(m.at || '');
        const at = new Date(m.at);
        if (!Number.isNaN(at.getTime())) when.title = at.toLocaleString();
        when.textContent = whenText(m.at) || String(m.at || '');
        sum.append(`${String(m.sender || '')} \u00b7 `, when);
        const p = document.createElement('p');
        p.className = 'composer-waiting-body';
        p.textContent = String(m.text || '') + (m.truncated ? ' \u2026' : '');
        d.append(sum, p);
        root.append(d);
    }
    return root;
}

async function toggleList() {
    const s = state.currentSession, d = document.getElementById('composer-waiting-detail'), b = document.getElementById('composer-waiting-list'), items = document.getElementById('composer-waiting-items');
    if (!s || !d || !b || !items) return;
    if (!d.hidden) { closeList(); return; }
    try {
        const resp = await serverFetch(currentServer(), url(s, `?agent_type=${encodeURIComponent(s.agent_type)}&session_id=${encodeURIComponent(s.session_id)}`));
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `The list could not be read (HTTP ${resp.status}).`)); return; }
        items.replaceChildren(listNode(await resp.json()));
        d.hidden = false;
        b.setAttribute('aria-expanded', 'true');
    } catch (e) {
        showToast('The list could not be read: ' + (e && e.message ? e.message : 'the server did not answer.'));
    }
}

let busy = false;

async function sendNow() {
    const s = state.currentSession;
    if (!s || busy) return;
    busy = true;
    try {
        const resp = await serverFetch(currentServer(), url(s, '/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_type: s.agent_type, session_id: s.session_id }),
        });
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `Not sent (HTTP ${resp.status}).`)); return; }
        showToast(sendNowToast(await resp.json()));
    } catch (e) {
        showToast('Not sent: ' + (e && e.message ? e.message : 'the server did not answer.'));
    } finally { busy = false; }
}

/** Text from the server or a row reduced to one plain line for the confirm: control, format and bidi characters dropped, blanks collapsed,
 *  capped with an ellipsis (the server's own caps: 64 for a name, 120 for a folder). A folder keeps its tail, the part nearest the file,
 *  behind a leading ellipsis (Security's #4850). */
function plain(v, max, tail = false) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return tail ? '…' + s.slice(s.length - (max - 1)) : s.slice(0, max - 1) + '…';
}

/** Whether recording this candidate needs the box ticked: a program inside a nested shell, or one whose image can't be read (Security's
 *  rules on #391). */
export const needsAck = c => !!(c && (c.under || c.unidentified));

/** What Record as agent asks before it records (Backend Dev's wording, #391). The program's name and folder come from its image, through
 *  the server; the name is the row's. */
export function recordConfirmText(c, agentName) {
    const who = plain(agentName, 64) || 'this agent';
    const tail = `as ${who}'s agent? Coral will then type board notices into it.`;
    // An image Coral can't read: no name to show, so it says so (the server's "an unknown program (pid N)"), and the box is needed.
    if (c.unidentified) return `Record an unknown program (pid ${Number(c.pid)}) ${tail} Coral could not read which file this program runs.`;
    const folder = plain(c.folder, 120, true);
    const base = `Record ${plain(c.program, 64) || 'the program'} (pid ${Number(c.pid)})${folder ? `, from ${folder},` : ''} ${tail}`;
    // A program inside a shell started in the terminal: said plainly, and recorded only with the box ticked.
    return c.under ? `${base} This program is running inside ${plain(c.under, 64)}, a shell started in the terminal, not directly in the agent's terminal.` : base;
}

/** The box a nested or unidentified candidate needs ticked before it is recorded (#391). */
export const NESTED_ACK = "I know this is the agent, not something I started by hand";

/** What is said after Record for all agents, from the server's answer: how many were recorded, and each one left paused with why. */
export function recordAllText(r) {
    const done = Array.isArray(r && r.recorded) ? r.recorded.length : 0;
    const left = Array.isArray(r && r.left) ? r.left : [];
    let t = `Recorded ${done} agent${done === 1 ? '' : 's'}.`;
    if (left.length) t += ` Left paused: ${left.map(l => `${plain(l.session, 64)} (${plain(l.reason, 200) || 'no reason given'})`).join('; ')}.`;
    return t;
}

const recordUrl = (s, tail) => `/api/sessions/live/${encodeURIComponent(s.session_id)}/${tail}`;

/** Record as agent (#391): read the one candidate the server offers, ask, and record it with the start it gave; a candidate that changed
 *  meanwhile (409) records nothing, and the button reads again. */
async function recordAgent() {
    const s = state.currentSession;
    if (!s || busy) return;
    busy = true;
    try {
        const resp = await serverFetch(currentServer(), recordUrl(s, 'agent-candidate'));
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `The agent could not be read (HTTP ${resp.status}).`)); return; }
        const r = await resp.json();
        if (!r.paused) { showToast('Board notices already go to this agent.'); return; }
        if (!r.candidate) { showToast(`Nothing to record: ${String(r.why_not || 'no single program runs in the terminal')}.`); return; }
        const c = r.candidate;
        const name = String(s.display_name || s.name || 'this agent');
        showConfirmModal('Record as agent', recordConfirmText(c, name), acknowledged => postRecord(s, c, acknowledged), undefined,
            needsAck(c) ? { label: 'Record', danger: false, acknowledge: NESTED_ACK } : { label: 'Record', danger: false }); // recording loses nothing: it ends a pause
    } catch (e) {
        showToast('The agent could not be read: ' + (e && e.message ? e.message : 'the server did not answer.'));
    } finally { busy = false; }
}

async function postRecord(s, c, acknowledged) {
    const body = { pid: Number(c.pid), start: String(c.start || '') };
    if (needsAck(c) && acknowledged) body.acknowledge_nested = true; // only with the box ticked, and only for a candidate that needs it
    try {
        const resp = await serverFetch(currentServer(), recordUrl(s, 'record-agent'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (resp.status === 409) { showToast('The program in the terminal changed: nothing was recorded. Read it again.'); return; }
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `Not recorded (HTTP ${resp.status}).`)); return; }
        const r = await resp.json();
        showToast(`Recorded ${plain(r.program || c.program, 64) || 'the program'} as the agent: board notices go to it again.`);
    } catch (e) {
        showToast('Not recorded: ' + (e && e.message ? e.message : 'the server did not answer.'));
    }
}

/** Record for all agents (#391, after an update): the server records every agent whose program is its resolved CLI and leaves the rest
 *  paused, each with why; nothing is guessed. */
async function recordAllAgents() {
    if (busy) return;
    busy = true;
    try {
        const resp = await serverFetch(currentServer(), '/api/sessions/record-agents', { method: 'POST' });
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `Not recorded (HTTP ${resp.status}).`)); return; }
        showToast(recordAllText(await resp.json()));
    } catch (e) {
        showToast('Not recorded: ' + (e && e.message ? e.message : 'the server did not answer.'));
    } finally { busy = false; }
}

registerActions({
    'waiting-toggle': () => toggleList(),
    'waiting-send-now': () => sendNow(),
    'agent-record': () => recordAgent(),
    'agent-record-all': () => recordAllAgents(),
});
