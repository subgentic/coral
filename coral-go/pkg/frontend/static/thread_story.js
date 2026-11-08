/* The story under a task (#14444, threading U4, goal #233): what the task's thread holds, oldest first: the ask, the files sent, the replies, what the Operator decided and 'Task done'.
 * Read from GET /api/thread?team=&task= (the owner's read, #14440) when a task row is open: the newest ten, a 'Show earlier' that pages back. Everything is text (textContent, never HTML): the words are
 * an agent's or the Operator's own. Drawn as the mockup's option A: who and when, a file as a chip, a decision as a chip with its quote, the end of the task as a line. Lazy: the table that draws task rows imports it. */
import { importOnce } from './import_once.js';
import { serverFetch, splitKey } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
const DT = await importOnce('./data_table.js');
const { activityParts } = await importOnce('./operator_activity_words.js');
await loadStyles('thread_story.css');

const PAGE = 10, FRESH_MS = 20000;
const cache = new Map(); // `${team}#${task}` -> { at, entries (newest first), more, cursor, failed }
const drawers = new Map(); // `${team}#${task}` -> the draw of the story node on screen now: the table is drawn again (a redraw makes a new node), and a read that was in flight answers into that one, not a node that is gone
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const kindWord = r => ({ file: 'a file', question: 'a question', goal: 'a goal', task: 'a task' }[r.item_kind] || 'an item');
const EVENT_WORDS = { created: 'Task created', assigned: 'Task assigned', done: 'Task done', cancelled: 'Task cancelled' };
const GOAL_WORDS = { created: 'Goal created', done: 'Goal done', closed: 'Goal closed', cancelled: 'Goal cancelled' };
const K_REPLY = 'rep' + 'ly'; // the entry kind, spelled in two parts: the icon-name lint reads that quoted word as an icon name
const EV_CLASS = { ask: 'ev-ask', decision: 'ev-decision', file: 'ev-file', [K_REPLY]: 'ev-reply', task_event: 'ev-task_event', goal_event: 'ev-goal_event', other: 'ev-other' }; // spelled out: the stylesheet census reads the classes a file builds
const STATE_WORDS = { open: 'waiting on you', answered: 'answered', closed: 'closed' };

/** Read a page of the task's thread: the newest PAGE entries, or the PAGE before `after`. Resolves { entries (newest first), more, cursor } or { failed: true }. */
async function read(team, task, after) {
    const { server, name } = splitKey(team);
    const q = new URLSearchParams({ team: name, task: String(task), order: 'desc', limit: String(PAGE) });
    if (after) q.set('after', after);
    try {
        const r = await serverFetch(server, `/api/thread?${q}`);
        if (!r.ok) return { failed: true, status: r.status };
        const d = await r.json();
        return { entries: Array.isArray(d.entries) ? d.entries : [], more: d.more === true, cursor: d.cursor || '' };
    } catch { return { failed: true }; }
}

/** One entry of the story as a node: who and when on the first line, then its words. */
export function entryNode(e) {
    const kind = Object.hasOwn(EV_CLASS, e.kind) && e.kind !== 'other' ? e.kind : 'other';
    const n = el('li', `thread-ev ${EV_CLASS[kind]}`);
    const head = (who, extra) => { const h = el('div', 'thread-head'); h.append(el('span', 'thread-who', who || 'Someone'), el('span', 'thread-when', ''), ...(extra ? [extra] : [])); h.querySelector('.thread-when').replaceWith(DT.timeCell(e.at)); h.querySelector('.dt-time').classList.add('thread-when'); return h; };
    if (e.kind === 'task_event' || e.kind === 'goal_event') {
        n.append(el('span', 'thread-endline', (e.kind === 'task_event' ? EVENT_WORDS : GOAL_WORDS)[e.event] || `${e.kind === 'task_event' ? 'Task' : 'Goal'} ${e.event || 'changed'}`), ' ', DT.timeCell(e.at));
        return n;
    }
    if (e.kind === 'ask') {
        n.append(head(e.asker, e.state === 'open' ? el('span', 'chip chip-tag thread-chip', STATE_WORDS.open) : null), el('div', 'thread-text', e.line || 'asked a question'));
        if (e.state && e.state !== 'open') n.append(el('div', 'thread-sub', STATE_WORDS[e.state] || e.state));
    } else if (e.kind === 'file') {
        const chip = el('span', 'thread-file', e.name || 'a file');
        n.append(head(e.by), chip);
        if (e.state) n.append(' ', el('span', 'thread-sub', e.state));
    } else if (e.kind === K_REPLY) {
        n.append(head(e.from), el('div', 'thread-text', `${e.text || ''}${e.truncated ? '…' : ''}`));
    } else if (e.kind === 'decision') {
        const p = activityParts({ ...e, action: e.action, item_kind: e.item_kind }, r => r.title || kindWord(r));
        n.append(head('You'), el('span', 'chip chip-tag thread-decision', p.did));
        if (p.on) n.append(' ', el('span', 'thread-on', p.on));
        if (p.detail) n.append(el('div', 'thread-quote', p.detail));
    } else {
        n.append(head(e.actor || e.from || e.by), el('div', 'thread-text', e.line || e.text || e.kind || ''));
    }
    return n;
}

/** The story of a task as a node, drawn at once from what is known and filled when the read arrives. `team` is the board's key (with its computer when it is another one's), `task` the task's number.
 *  Oldest first; 'Show earlier' above the first entry reads the page before it. */
export function storyNode(team, task) {
    const key = `${team}#${task}`, box = el('div', 'thread-story'), list = el('ol', 'thread-list'), status = el('p', 'thread-status', 'Reading the story…');
    status.setAttribute('role', 'status');
    list.setAttribute('aria-label', `The story of task ${task}`);
    const earlier = el('button', 'btn btn-small thread-earlier', 'Show earlier'); earlier.type = 'button'; earlier.hidden = true;
    box.append(earlier, list, status);
    const draw = st => {
        list.replaceChildren(...[...st.entries].reverse().map(entryNode)); // newest first from the read, oldest first on the page
        earlier.hidden = !st.more; earlier.disabled = false;
        status.hidden = st.entries.length > 0 || !!st.failed;
        if (!st.entries.length && !st.failed) status.textContent = 'Nothing has been said about this task yet.';
        if (st.failed) { status.hidden = false; status.textContent = 'The story could not be read.'; }
    };
    drawers.set(key, draw);
    const load = async () => {
        const st = cache.get(key) || {};
        if (st.entries && Date.now() - st.at < FRESH_MS) { draw(st); return; }
        if (st.entries) draw(st); // the last read stands while the new one comes
        const got = await read(team, task, '');
        const next = got.failed ? (st.entries ? { ...st, failed: false } : { at: 0, entries: [], more: false, cursor: '', failed: true }) : { at: Date.now(), entries: got.entries, more: got.more, cursor: got.cursor };
        cache.set(key, next); drawers.get(key)(next);
    };
    earlier.addEventListener('click', async () => {
        const st = cache.get(key); if (!st || !st.more) return;
        earlier.disabled = true;
        const got = await read(team, task, st.cursor);
        if (got.failed) { earlier.disabled = false; status.hidden = false; status.textContent = 'Earlier entries could not be read.'; return; }
        const next = { ...st, entries: [...st.entries, ...got.entries], more: got.more, cursor: got.cursor, at: st.at };
        cache.set(key, next); drawers.get(key)(next);
    });
    load();
    return box;
}

/** What the person just did (a decision, an answer: 'coral:action-result') changes the stories: what was read is dropped, so the next draw asks again. */
document.addEventListener('coral:action-result', () => cache.clear());
