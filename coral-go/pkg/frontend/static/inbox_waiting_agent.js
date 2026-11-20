/* Waiting on an agent: the two kinds that are not a file the Operator sent back (#19904, the approved two-tab mock, server side #19916): an ASK the Operator answered ("Your answer: ...") and a COMMENT the Operator sent
 * ("You commented: ..."), each still waiting on the agent. Read from GET /api/waiting-on-agent (the Operator's alone; oldest first, at most 100). The rows are never counted in a badge: only the tab says how many.
 * The words are the Operator's own, set with textContent only; the agent's name goes through the hidden-mark guard like every agent text. */
import { serverFetch, LOCAL_SERVER, boardTeamKey, isCloud } from './server_base.js';
import { markHidden } from './visible_marks.js';
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
const { KINDS, KIND_LABEL, KIND_ART } = await importOnce('./needs_filters.js');
import { browserLocal } from './safe_storage.js';

export const KIND_WORD = { answered_ask: 'Answered ask', comment_sent: 'Comment sent' };
const FRESH_MS = 30000;
const DISMISS_KEY = 'coral-inbox-wait-dismissed';
const dismissed = (() => { try { const v = JSON.parse(browserLocal.get(DISMISS_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); } })();
const keyOf = it => `${it.kind}:${it.id}`;
/** Stop waiting: the item leaves this list in this browser; nobody is told. */
export const dismiss = it => { dismissed.add(keyOf(it)); browserLocal.set(DISMISS_KEY, JSON.stringify([...dismissed].slice(-500))); };
let items = [], failed = false, readAt = 0, inflight = null, redraw = () => {};

/** The rows as the list holds them: a row that is not a file, an agent or an ask, with the fields the table reads. */
export const rows = (sentBack = new Set()) => items.filter(it => !dismissed.has(keyOf(it)) && !(it.kind === 'comment_sent' && sentBack.has(String(it.artifact?.hex || '').toLowerCase()))).map(it => ({
    waitItem: it, session_id: `waiting-agent:${it.kind}:${it.id}`, display_name: it.agent?.name || 'Unknown agent', board_project: it.board || '', server: LOCAL_SERVER,
    waiting_kind: it.kind, waiting_summary: wordsOf(it), waiting_since: it.since, agentRef: refOf(it),
    goal: it.goal?.id ? { id: it.goal.id, title: String(it.goal.title || `Goal #${it.goal.id}`), board: it.board } : null, task: it.task?.id ? { id: it.task.id, title: String(it.task.title || '') } : null,
}));
/** What the agent-state reader takes: the agent's name, its session and its team. */
export const refOf = it => ({ produced_by: it.agent?.name || '', session_id: it.agent?.session_id || '', team: it.board || '' });
export const failedToRead = () => failed;
export const wordsOf = it => it.operator_words ? `${it.kind === 'answered_ask' ? 'Your answer' : 'You commented'}: “${String(it.operator_words).replace(/\s+/g, ' ').trim()}”` : '';
// the second tab's own kinds: known to the filter (a pill, a saved choice), labelled, and drawn as an ask's and a file's icon
KINDS.push('answered_ask', 'comment_sent'); Object.assign(KIND_LABEL, { answered_ask: 'Answered ask', comment_sent: 'Comment sent' }); Object.assign(KIND_ART, { answered_ask: 'ask', comment_sent: 'review' });
/** The title line: the ask's question, or the file or goal the Operator commented on. */
export const titleOf = it => String(it.title || (it.artifact && it.artifact.name) || (it.goal && it.goal.title) || (it.kind === 'answered_ask' ? 'A question' : 'A comment'));

/** Read the list (at most every 30 seconds unless forced); `onChange` draws the Inbox again when the answer differs. A computer that cannot answer (a Hub-viewed Coral, an old server) is an error line, not an empty tab. */
export function load({ force = false, onChange = null } = {}) {
    if (onChange) redraw = onChange;
    if (inflight || (!force && Date.now() - readAt < FRESH_MS)) return inflight;
    inflight = (isCloud() ? Promise.reject(new Error('hub')) : serverFetch(LOCAL_SERVER, '/api/waiting-on-agent')).then(async r => { if (!r.ok) throw new Error(String(r.status)); const d = await r.json(); return Array.isArray(d?.items) ? d.items : []; })
        .then(got => { const was = JSON.stringify([items, failed]); items = got; failed = false; return was !== JSON.stringify([items, failed]); }, () => { const was = failed; failed = true; items = []; return !was; })
        .then(changed => { readAt = Date.now(); inflight = null; if (changed) redraw(); });
    return inflight;
}
export const forget = () => { readAt = 0; };

/** The chip: "Answered ask · waiting on X" / "Comment sent · waiting on X", in the sent-back chip's look. */
export function chip(it, who) {
    const c = document.createElement('span'); c.className = 'chip inbox-sent-back'; c.setAttribute('data-wait-kind', it.kind); c.textContent = KIND_WORD[it.kind];
    c.title = it.kind === 'answered_ask' ? 'You answered the agent. It has not acted or replied since.' : 'You commented. The agent has not replied since.';
    return c;
}
/** The Operator's own words, one quiet line under the chip. */
export const quote = it => { const q = el('span', 'inbox-sent-back-ask', wordsOf(it)); q.hidden = !q.textContent; return q; };
/** The goal and the task the item serves, as the pills of a file row. */
export function pills(it, { openGoal, openTask }) {
    const p = el('span', 'inbox-pills'), team = boardTeamKey(LOCAL_SERVER, it.board || '');
    if (it.goal?.id) { const g = el('button', 'inbox-pill inbox-pill-goal', `Goal #${it.goal.id}`); g.type = 'button'; g.addEventListener('click', () => openGoal(team, it.goal.id)); p.append(g); }
    if (it.task?.id) { const t = el('button', 'inbox-pill inbox-pill-task', `Task #${it.task.id}`); t.type = 'button'; t.addEventListener('click', () => openTask(team, it.task.id)); p.append(t); }
    return p;
}
export const whoOf = it => markHidden(it.agent?.name || 'the agent', { strict: true });
