/* Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question or for a permission carries the card's own choices (Yes, No, Red, Blue ...) as buttons, so a person answers
 * where they found it. The choices are read the way the chat reads them (the chat reply's prompt_options for that agent) and answered through the same route as the chat card (POST .../answer-prompt: the server re-reads the
 * terminal and sends the digit only if the option is still on screen under that label). A question the card cannot answer by one choice (a multi-select, a review step, a text answer, many choices) has no buttons: Open
 * stays for the full card. The labels are the CLI's own words, set as text.
 * A row never grants more than this one time (#10400, Security): the choices that say "don't ask again", "always", "allow all", "this session", "switch to ..." are left to Open. The click re-reads the card and
 * sends only when it is still the ask the row was drawn for (the ask_id the chat reply carries, checked again by the server); otherwise the row is drawn again and says so. A viewer through the Hub has no buttons. */
import { serverFetch, sessionServer } from './server_base.js';
import { showToast } from './utils.js';
import { blockedReason, hubBlocked } from './hub_access.js';

const MAX_CHOICES = 4;
// Choices that last past this one answer, or change how the agent runs: never a button on a list row (each CLI's own words: Claude's "Yes, and don't ask again for ..." and "Yes, allow all edits during this session", Codex's "Yes, and don't ask again", Antigravity's "always allow").
const LASTING = /don.?t ask|always|allow all|all edits|session|conversation|switch to|persist|remember|from now on|auto mode|accept edits/i;
// What a permission's choice may say to be a button: a short Yes, Allow, Approve, No, Deny or Reject, and nothing about a place or a scope ("Yes, allow reading from <dir>/ from this project" reaches further than this one time): everything else is left to Open (Security Reviewer, #10462).
const PLAIN = /^(yes|no|allow|deny|approve|reject)\b/i, SCOPE = /project|director|folder|repositor|\ball\b|\bfrom\b|\/|~/i, PERMISSION_WORDS = /^(yes|allow|approve)\b/i;
const plainlyOneTime = (label, permission) => !LASTING.test(label) && !SCOPE.test(label) && (!permission || (PLAIN.test(label) && label.length <= (PERMISSION_WORDS.test(label) ? 40 : 60)));
const read = new Map(); // server:session:waiting_since -> the choices, read once per ask

/** The card's one-time choices and the ask they belong to: { ask, picks } ({ ask: '', picks: [] } when the card cannot be answered by one choice). */
async function readAsk(s) {
    const params = new URLSearchParams({ after: '0', limit: '1', session_id: s.session_id, agent_type: s.agent_type || '' });
    const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/chat?${params}`);
    const none = { ask: '', picks: [] };
    if (!resp.ok) return none;
    const po = (await resp.json().catch(() => null) || {}).prompt_options;
    if (!po || po.multi || (po.review || []).length) return none;
    const permission = (po.options || []).some(o => PERMISSION_WORDS.test(String(o.label || ''))); // a permission card: only a plain Yes or No is a button; a question's own choices (Red, Blue) are
    const picks = (po.options || []).filter(o => (o.action || 'select') === 'select' && o.label && Number.isInteger(Number(o.n)) && plainlyOneTime(String(o.label), permission));
    return picks.length >= 1 && picks.length <= MAX_CHOICES ? { ask: String(po.ask_id || ''), picks } : none;
}

const askKey = s => `${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}`;

async function answer(s, o, ask, cell) {
    const buttons = [...cell.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    try {
        if (await hubBlocked(s)) { buttons.forEach(b => { b.disabled = false; }); return; } // a viewer: the reason is said
        const now = await readAsk(s); // the card is read again at the click: a row can be stale
        if (!ask || now.ask !== ask || !now.picks.some(p => Number(p.n) === Number(o.n) && p.label === o.label)) {
            read.delete(askKey(s));
            fill(s, cell);
            showToast('That question changed; look at it again.', true);
            return;
        }
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/answer-prompt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: s.session_id, agent_type: s.agent_type || '', n: Number(o.n), label: o.label, text: '', ask_id: ask }),
        });
        if (resp.status === 409) { read.delete(askKey(s)); fill(s, cell); showToast('That question changed; look at it again.', true); return; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        read.delete(askKey(s));
        cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Answered: ${o.label}` }));
        showToast(`Answered: ${o.label}`, false, 4000, { silent: true });
        document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id } }));
    } catch {
        buttons.forEach(b => { b.disabled = false; });
        showToast('Could not send the answer. Open the agent and use its terminal.', true);
    }
}

/** Draws the choices into the cell once they are read (again after a question changed). */
function fill(s, cell) {
    const key = askKey(s);
    if (!read.has(key)) read.set(key, readAsk(s).catch(() => ({ ask: '', picks: [] })));
    read.get(key).then(({ ask, picks }) => {
        cell.replaceChildren();
        for (const o of picks) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-small inbox-answer'; b.textContent = o.label;
            b.dataset.session = s.session_id; b.dataset.n = String(Number(o.n)); // what finds this choice again after a redraw keeps the keyboard on it (sidebar_groups.js)
            b.setAttribute('aria-label', `Answer ${o.label}`);
            b.addEventListener('click', e => { e.stopPropagation(); answer(s, o, ask, cell); });
            b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(b);
        }
    });
}

/** The Answer cell of a Needs you row: empty for a review or a run, for a viewer through the Hub, otherwise the one-time choices once they are read. */
export function answerCell(s) {
    if (s.review || s.autorun || !s.agent_type || !s.session_id || s.waiting_kind === 'login') return '';
    if (blockedReason(sessionServer(s), 'interact')) return '';
    const cell = document.createElement('span');
    cell.className = 'inbox-answers';
    fill(s, cell);
    return cell;
}
