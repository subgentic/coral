/* What waits for an agent (#7727). Coral types an agent's board nudges at once and holds nothing: when a prompt or menu is open, or the input box holds a draft, the text is not typed, and the unread
 * message stays on the board. The agent view says what is there (the row's board_unread and skipped_send), lists it on request (GET /waiting) and has Send now, the Operator's own action: the server
 * types the board nudge into the agent's input box whether or not it is in the middle of a turn, and never into a prompt that is open or over a draft. */
import { registerActions } from './actions.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { serverFetch, currentServer } from './server_base.js';
import { responseErrorText } from './server_status.js';
import { whenText } from './when_text.js';

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

/** The agent view's line: '' when no board message waits (a skipped send alone says nothing here). */
export function waitingText(row) {
    if (!row || row.sleeping) return '';
    const n = waitingCount(row);
    return n > 0 ? `${n} team message${n === 1 ? ' waits' : 's wait'} for this agent` : ''; // short on purpose (#10036): why it waits, the list and the actions are behind Options
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

registerActions({
    'waiting-toggle': () => toggleList(),
    'waiting-send-now': () => sendNow(),
});
