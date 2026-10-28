/* Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question or for a permission carries the card's own choices (Yes, No, Red, Blue ...) as buttons, so a person answers
 * where they found it. The choices are read the way the chat reads them (the chat reply's prompt_options for that agent) and answered through the same route as the chat card (POST .../answer-prompt: the server re-reads the
 * terminal and sends the digit only if the option is still on screen under that label). A question the card cannot answer by one choice (a multi-select, a review step, a text answer, many choices) has no buttons: Open
 * stays for the full card. The labels are the CLI's own words, set as text.
 * A row never grants more than this one time (#10400, Security): the choices that say "don't ask again", "always", "allow all", "this session", "switch to ..." are left to Open. The click re-reads the card and
 * sends only when it is still the ask the row was drawn for (the ask_id the chat reply carries, checked again by the server); otherwise the row is drawn again and says so. A viewer through the Hub has no buttons. */
import { serverFetch, sessionServer } from './server_base.js';
import { showToast } from './utils.js';
import { blockedReason, hubBlocked } from './hub_access.js';
import { resolveSessionIdentity } from './session_state.js';

const MAX_CHOICES = 4;
// Choices that last past this one answer, or change how the agent runs: never a button on a list row (each CLI's own words: Claude's "Yes, and don't ask again for ..." and "Yes, allow all edits during this session", Codex's "Yes, and don't ask again", Antigravity's "always allow").
const LASTING = /don.?t ask|always|allow all|all edits|session|conversation|switch to|persist|remember|from now on|auto mode|accept edits/i;
// A permission's choice is a button only when the WHOLE label (a trailing key hint like "(y)" and final punctuation dropped) is one of these one-time forms, and nothing else (Security Reviewer, #10462): Yes, Allow or Approve,
// optionally "once", "this once", "proceed", "continue", Antigravity's "run command"; No, Deny or Reject, optionally "cancel" or Codex's "and tell <CLI> what to do differently". Everything else, including every phrasing that
// lasts ("never ask again", "forever", "trust this workspace", "for the rest of this task") and every one that names a place, is left to Open.
const ONE_TIME = /^(?:(?:yes|allow|approve)(?:,? (?:once|this once|proceed|continue|run command))?|(?:no|deny|reject)(?:,? (?:cancel|and tell \w+ what to do differently))?)$/i;
const PERMISSION_WORDS = /^(yes|allow|approve)\b/i, SCOPE = /project|director|folder|repositor|\ball\b|\bfrom\b|\/|~/i;
const KEY_HINT = /\s*\((?:[a-z]|esc|enter|tab|shift\+tab|ctrl\+[a-z])\)$/i; // only a key in brackets is a hint: any other bracket ("(always)", "(all projects)") stays in the label, so the full match fails
const wholeLabel = label => label.trim().replace(KEY_HINT, '').replace(/[.!\s]+$/, '');
const plainlyOneTime = (label, permission) => permission ? ONE_TIME.test(wholeLabel(label)) : !LASTING.test(label) && !SCOPE.test(label); // a question card's own choices (Red, Blue) pass the words that mark a lasting or wide one
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

/** The row says what was answered; the Inbox is told, so the row goes when the agent stops waiting. */
function settled(s, o, cell) {
    cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Answered: ${o.label}` }));
    document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id } }));
}

const askKey = s => `${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}`;

async function answer(s, o, ask, cell) {
    const buttons = [...cell.querySelectorAll('button')];
    const had = cell.contains(document.activeElement); // the keyboard is on a choice: it must still be on something when the cell is drawn again or says Answered (#10560)
    const keep = () => { if (had) (cell.querySelector(`.inbox-answer[data-n="${Number(o.n)}"]`) || cell.querySelector('.inbox-answer') || cell.closest('tr')?.querySelector('.dt-primary'))?.focus({ preventScroll: true }); };
    buttons.forEach(b => { b.disabled = true; });
    try {
        if (await hubBlocked(s)) { buttons.forEach(b => { b.disabled = false; }); return; } // a viewer: the reason is said
        const now = await readAsk(s); // the card is read again at the click: a row can be stale
        if (!ask || now.ask !== ask || !now.picks.some(p => Number(p.n) === Number(o.n) && p.label === o.label)) {
            read.delete(askKey(s));
            fill(s, cell).then(keep);
            showToast('That question changed; look at it again.', true);
            return;
        }
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/answer-prompt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: s.session_id, agent_type: s.agent_type || '', n: Number(o.n), label: o.label, text: '', ask_id: ask }),
        });
        if (resp.status === 409) {
            const why = await resp.json().catch(() => ({}));
            if (/^That question changed/.test(why.error || '')) { read.delete(askKey(s)); fill(s, cell).then(keep); showToast('That question changed; look at it again.', true); return; } // the server saw another ask than the one drawn
            if (why.code === 'prompt_still_open') { read.delete(askKey(s)); settled(s, o, cell); showToast(`Sent: ${o.label}. The agent's prompt is still open: look at it.`, false, 6000); return; } // the answer went; the prompt had not gone yet
            throw new Error(why.error || 'HTTP 409');
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        read.delete(askKey(s));
        cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Answered: ${o.label}` }));
        if (had) cell.closest('tr')?.querySelector('.dt-primary')?.focus({ preventScroll: true }); // the choices are gone: the keyboard stays in the row, on its Open
        showToast(`Answered: ${o.label} for ${resolveSessionIdentity(s)}`, false, 4000); // said once by the page's live region: nothing else says it
        document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id } }));
    } catch {
        buttons.forEach(b => { b.disabled = false; });
        // the way to answer it is a button, not a place to go looking for (#10399): Open agent shows that agent's own card
        showToast('Could not send the answer from here. Open the agent to answer it there.', true, 10000, { action: { label: 'Open agent', onClick: () => { window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id, sessionServer(s))).then(() => window.showChatView?.()); } } });
    }
}

/** Draws the choices into the cell once they are read (again after a question changed). */
function fill(s, cell) {
    const key = askKey(s);
    if (!read.has(key)) read.set(key, readAsk(s).catch(() => ({ ask: '', picks: [] })));
    return read.get(key).then(({ ask, picks }) => {
        cell.replaceChildren();
        for (const o of picks) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-small inbox-answer'; b.textContent = o.label;
            b.dataset.session = s.session_id; b.dataset.n = String(Number(o.n)); // what finds this choice again after a redraw keeps the keyboard on it (sidebar_groups.js)
            b.setAttribute('aria-label', `Answer ${o.label} for ${resolveSessionIdentity(s)}`);
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
