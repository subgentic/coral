/* The history of the resource queue's runs, under the Queue folder's live table (#13724, the Operator's "a list of the history of the runs"): every entry that ended, newest first, with the agent, the resource and
 * its computer, the task and its goal, the pattern the hook matched (never a command), when it started, how long it waited and held, and how it ended. It reads GET /api/analytics/resource-queue/runs, this computer's
 * and the Operator's alone: 50 a request, the next 50 by the cursor it answers with, filtered by resource and agent and searched by the folder's own search box (the server searches, so a run that is not on the
 * first page is found). The live table above keeps its own rules; this one has no buttons that change the queue. Agent, task and goal are the same links as the live table's. Everything is drawn with textContent. */
import { compactDuration, formatMonthDayTime } from './format.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const { agentLink } = await importOnce('./agent_link.js');
const { liveAgentOf, openAgent } = await importOnce('./agent_live.js');

/** How a run ended, in words (the server's codes). */
export const END_WORDS = {
    released: 'Released', call_ended: 'Call ended', unused: 'Not used', cap: 'Time cap', gone: 'Session ended', expired: 'Lease ran out',
    kicked: 'Kicked', kicked_from_line: 'Kicked from the line', left_line: 'Left the line', ran_anyway: 'Ran anyway',
};
const endWord = r => END_WORDS[r.end] || 'Ended';
const STOPPED = new Set(['kicked', 'kicked_from_line', 'expired', 'cap']); // an end that was not the agent's own

const PAGE = 50;
const st = { runs: [], next: '', loaded: false, loading: false, error: false, recorded: true, resources: [], agents: [], resource: '', agent: '', q: '', version: 0, wanted: false, timer: 0, seq: 0, qTimer: 0 };
let listeners = new Set(), frozenSignature = null;

export const onHistoryChanged = fn => { listeners.add(fn); };
/** Changes whenever what the history shows does, so the page's key can carry it. */
export const historyVersion = () => st.version;
let shown = ''; // what the page last drew: a read that changes nothing redraws nothing (a redraw would take the keyboard out of the live table's button)
const stamp = () => JSON.stringify([st.runs.map(r => r.key), st.next, st.loaded, st.loading, st.error, st.recorded, st.resources, st.agents, st.resource, st.agent]);
const bump = (force = false) => { const now = stamp(); if (!force && now === shown) return; shown = now; st.version++; for (const fn of listeners) fn(); };

const params = (extra = {}) => {
    const p = new URLSearchParams();
    if (st.resource) p.set('resource', st.resource);
    if (st.agent) p.set('agent', st.agent);
    if (st.q.trim()) p.set('q', st.q.trim());
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    p.set('limit', String(PAGE));
    return p.toString();
};

/** Read the first page again (after a filter, a search, or the live queue changed); more=true reads the page after the last one shown and adds it. A reply for an older question is dropped. */
export async function readHistory({ more = false } = {}) {
    const seq = ++st.seq;
    st.loading = true; if (more) bump(); // the button says it is reading
    try {
        const r = await fetch(`/api/analytics/resource-queue/runs?${params(more ? { before: st.next } : {})}`);
        if (seq !== st.seq) return;
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.json();
        const got = Array.isArray(b.runs) ? b.runs : [];
        st.recorded = b.history !== false;
        st.resources = Array.isArray(b.resources) ? b.resources : [];
        st.agents = Array.isArray(b.agents) ? b.agents : [];
        if (more) { const have = new Set(st.runs.map(x => x.key)); st.runs = [...st.runs, ...got.filter(x => !have.has(x.key))]; st.next = b.next || ''; }
        else if (st.runs.length > PAGE) { // a live refresh keeps the pages already opened: the new runs join the top, the cursor stays
            const have = new Set(st.runs.map(x => x.key));
            const fresh = got.filter(x => !have.has(x.key));
            st.runs = [...fresh, ...st.runs];
        } else { st.runs = got; st.next = b.next || ''; }
        st.loaded = true; st.error = false;
    } catch { if (seq !== st.seq) return; st.error = true; } finally { if (seq === st.seq) { st.loading = false; bump(); } }
}

/** Start or stop: on while the Queue folder is the one on screen. The live queue's own changes read the first page again (an entry that ended is a new run). */
export function watchHistory(on) {
    st.wanted = !!on;
    if (!st.wanted) { clearInterval(st.timer); st.timer = 0; return; }
    if (!st.loaded && !st.loading) readHistory();
    if (!st.timer) st.timer = pollEvery(() => { if (st.wanted && !document.hidden && !focusedFilter()) readHistory(); }, 30000); // a backstop: the live queue's changes read it sooner
}
/** The live queue changed: a run may have ended. */
export function queueMoved() { if (st.wanted && st.loaded && !focusedFilter()) readHistory(); }

/** The folder's search text: the server searches, a moment after the typing stops. */
export function setSearch(q) {
    q = String(q || '');
    if (q === st.q) return;
    st.q = q;
    clearTimeout(st.qTimer);
    st.qTimer = setTimeout(() => { st.runs = []; st.next = ''; st.loaded = false; readHistory(); bump(); }, 250);
}
const setFilter = (key, value) => { st[key] = value; st.runs = []; st.next = ''; st.loaded = false; bump(); readHistory(); };
const focusedFilter = () => { const a = document.activeElement; return !!(a && a.classList && a.classList.contains('qh-filter')); };

const time = iso => { const d = new Date(iso || ''); return Number.isFinite(d.getTime()) ? formatMonthDayTime(d) : ''; };
const waitedWords = r => (r.wait_s >= 1 ? compactDuration(r.wait_s) : 'No wait');
const heldWords = r => (r.started_at ? (r.held_s >= 1 ? compactDuration(r.held_s) : 'Under a second') : '');
const openTask = (r, from) => importOnce('./task_navigation.js').then(m => m.openTask(r.project, r.task, from, { from: '' }));
const openGoal = r => importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(r.project, r.goal_id));
const goalWords = r => `#${r.goal_id} ${r.goal_title}`;
const taskLink = r => (r.task && r.project ? DT.link(`#${r.task}`, ev => openTask(r, ev && ev.currentTarget)) : r.task ? DT.el('span', '', `#${r.task}`) : ''); // an old row has no board: its task is text
const goalLink = r => { if (!(r.goal_id && r.project)) return ''; const b = DT.link(goalWords(r), () => openGoal(r)); b.classList.add('queue-goal'); b.title = goalWords(r); b.setAttribute('aria-label', `Open goal ${goalWords(r)}`); return b; };
const linkActions = r => [
    ...(liveAgentOf(r.agent, { board: r.project }) ? [{ label: `Open ${r.agent}`, title: `Open ${r.agent}`, run: () => openAgent(liveAgentOf(r.agent, { board: r.project })) }] : []),
    ...(r.task && r.project ? [{ label: `Task #${r.task}`, title: `Open task #${r.task}`, link: true, run: () => openTask(r, null) }] : []),
    ...(r.goal_id && r.project ? [{ label: `Goal #${r.goal_id}`, title: `Open goal ${goalWords(r)}`, link: true, run: () => openGoal(r) }] : [])];

/** What the history says when it has no row. */
const emptyLine = () => (st.error ? 'The history could not be read.'
    : !st.recorded ? 'The queue’s record could not be opened on this computer, so its history is not kept.'
        : !st.loaded ? 'Reading the history.'
            : st.q.trim() || st.resource || st.agent ? 'No run matches the search and filters.' : 'No run has ended yet. A run appears here when its agent gives the slot back or it is removed.');

/** A signature of what the history shows, for the table's redraw key; frozen while a filter has the keyboard so its open list is not drawn away. */
export function historySignature() {
    const now = JSON.stringify([st.version, st.runs.length, st.next]);
    if (focusedFilter() && frozenSignature !== null) return frozenSignature;
    frozenSignature = now;
    return now;
}

function select(label, value, options, onPick) {
    const wrap = DT.el('label', 'qh-field');
    wrap.append(DT.el('span', 'qh-field-label', label));
    const s = DT.el('select', 'qh-filter');
    s.setAttribute('aria-label', label);
    for (const [v, text] of [['', `All ${label.toLowerCase()}s`], ...options.map(o => [o, o])]) { const o = DT.el('option', '', text); o.value = v; if (v === value) o.selected = true; s.append(o); }
    s.addEventListener('change', () => onPick(s.value));
    s.addEventListener('blur', () => { frozenSignature = null; bump(); }); // what arrived while the list was open is drawn now
    wrap.append(s);
    return wrap;
}

/** The history's section: a heading, the two filters, the table and its Show more button. */
export function historySection() {
    const sec = DT.el('section', 'qh-section');
    sec.setAttribute('aria-labelledby', 'qh-title');
    const head = DT.el('div', 'qh-head');
    const h = DT.el('h3', 'qh-title', 'History'); h.id = 'qh-title';
    const count = DT.el('span', 'session-group-count', st.loaded ? `${st.runs.length}${st.next ? '+' : ''}` : '');
    head.append(h, count);
    if (st.recorded) {
        const filters = DT.el('div', 'qh-filters');
        filters.append(select('Resource', st.resource, st.resources, v => setFilter('resource', v)), select('Agent', st.agent, st.agents, v => setFilter('agent', v)));
        head.append(filters);
    }
    sec.append(head);
    if (!st.runs.length) {
        const box = DT.el('div', 'empty-state empty-state-tight'), p = DT.el('p', 'empty-state-line', emptyLine()); p.setAttribute('role', 'status');
        if (st.error) { const b = DT.el('button', 'btn btn-small', 'Retry'); b.type = 'button'; b.addEventListener('click', () => readHistory()); p.append(' ', b); }
        box.append(p); sec.append(box);
        return sec;
    }
    sec.append(DT.dataTable({
        label: `Queue history, ${st.runs.length}`, rows: st.runs, oneLine: true, resize: true, keepOrder: true, rowKey: r => r.key, rowName: r => `${r.agent}, ${r.resource}, ${endWord(r)}`,
        columns: [ // the data_table.css steps are 62, 52, 36, 28 and 16 rem: a narrow list drops the pattern and the goal (62), then the task, the start and the wait (52), then the resource (36)
            { key: 'agent', label: 'Agent', primary: true, width: 'grow', cell: r => agentLink(r.agent, { board: r.project, cls: 'queue-agent' }) },
            { key: 'resource', label: 'Resource', width: '7rem', dropAt: 36, cell: r => { const s = DT.el('span', ''); s.textContent = r.resource; if (r.machine) s.title = `${r.resource} on ${r.machine}`; return s; } },
            { key: 'task', label: 'Task', width: '5.5rem', dropAt: 52, cell: taskLink },
            { key: 'goal', label: 'Goal', width: '8rem', dropAt: 52, cell: goalLink },
            { key: 'why', label: 'Note', width: '9rem', dropAt: 62, tone: 'tertiary', cell: r => r.pattern || '' },
            { key: 'start', label: 'Started', width: '8rem', dropAt: 52, tone: 'tertiary', cell: r => (r.started_at ? time(r.started_at) : '') },
            { key: 'wait', label: 'Waited', width: '5.5rem', dropAt: 52, tone: 'tertiary', cell: waitedWords },
            { key: 'held', label: 'Held', width: '5.5rem', tone: 'tertiary', cell: heldWords },
            { key: 'end', label: 'Ended', width: '11rem', cell: r => DT.chip(endWord(r), STOPPED.has(r.end) ? 'goal-state-task-blocked' : '') },
        ],
        mail: r => ({ lead: { icon: STOPPED.has(r.end) ? 'cancel' : 'check_circle', square: true, name: endWord(r) }, title: r.agent, medium: true, snippet: `${r.resource}${r.pattern ? ' · ' + r.pattern : ''}`, state: endWord(r), time: time(r.started_at || r.ended_at),
            ask: `${endWord(r)}${r.started_at ? ' · held ' + heldWords(r).toLowerCase() : ''} · waited ${waitedWords(r).toLowerCase()}`, // a second line: how it ended and for how long; the first line is who, where and when
            actions: linkActions(r).map(a => ({ label: a.label, title: a.title, run: a.run })) }),
    }).el);
    if (st.next) {
        const more = DT.el('button', 'btn qh-more', st.loading ? 'Reading…' : 'Show more');
        more.type = 'button'; more.disabled = st.loading; more.setAttribute('aria-label', `Show ${PAGE} more runs`);
        more.addEventListener('click', () => readHistory({ more: true }));
        sec.append(more);
    }
    return sec;
}
