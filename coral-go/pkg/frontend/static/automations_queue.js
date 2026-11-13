/* Who sees Move and Kick (#13651, the Orchestrator's ruling): the Queue folder is local-only (its routes are never reached through the Hub), so its one viewer is the Operator, who is always a manager. There is no
 * up-front permission check; the server still decides, and a 403 (anything else asking) takes the buttons away for good.
 * The Queue folder of Automations (#13651, goal #225): the resource queue of this computer (GET /api/resources) as one table, each resource a group: its name, how many of its slots are in use,
 * then who holds a slot (the agent, the note the agent gave, the lease left) and the waiting line in order (the place, the note, how long it has waited). The Operator can move an entry in the
 * line (first, up, down) and kick one (a holder is told its lease is gone, a waiting entry leaves the line); the server decides (a 403 hides the buttons for good, a 404 is the entry already gone).
 * A note is the pattern the agent named, never a command: it is drawn as text and nothing here builds a command from it. Read when the folder is shown and every few seconds while it is. */
import { compactDuration } from './format.js';
import { announceNotice } from './notifications.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';
import { registerActions } from './actions.js';
import { isCloud, serverFetch } from './server_base.js';
const HUB_WORDS = 'The queue is kept by each computer: open this computer\'s own Coral to see it, and move or remove an entry there.';
const DT = await importOnce('./data_table.js');
const { agentLink } = await importOnce('./agent_link.js');
const { liveAgentOf, openAgent } = await importOnce('./agent_live.js'); // the one way an agent's name opens its chat (#12168); a task and a goal open where their own links do (opened when clicked)

const POLL_MS = 5000;
/** Which computer's queue is read (#16030): 'local' is this one, anything else is a linked server read through the hub's own link (GET /api/remote/<id>/api/resources). What was last read is kept per computer, with when, so a computer that stops answering still shows its last queue and when it was read. A linked computer's queue is read-only here: Move and Kick are this computer's alone. */
let machine = 'local';
const lastRead = new Map(); // server id -> { resources, at }
export const queueMachine = () => machine;
export const queueReadOnly = () => machine !== 'local';
export const queueUnavailable = () => unavailable;
export const queueLoaded = () => loaded;
/** When the shown queue was last read from the computer chosen (ms), or 0 when it has not been. */
export const queueReadAt = () => (machine === 'local' ? (loaded ? Date.now() : 0) : (lastRead.get(machine) || { at: 0 }).at);
export function setQueueMachine(id) {
    const next = !id || id === 'local' ? 'local' : String(id);
    if (next === machine) return;
    machine = next; reading = null; unavailable = ''; denied = false;
    const kept = machine === 'local' ? null : lastRead.get(machine);
    resources = kept ? kept.resources : []; loaded = !!kept;
    emit(); refreshQueue();
}
let unavailable = '', resources = [], loaded = false, denied = false, timer = 0, tickTimer = 0, listeners = new Set(), wanted = false, reading = null, pendingFocus = null;
const TICK_MS = (typeof window !== 'undefined' && Number(window.__queueTickMs)) || 30000; // the lease and the wait are said again at least this often, with no data change (#13651)

/** Tell the folder the data or the clock changed. A button of the table that has the keyboard keeps it: the table is drawn again, so the same entry's same button is focused after (restoreFocus). */
const emit = () => {
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('queue-act') && !pendingFocus) { const m = /-(\d+)$/.exec((a.closest('tr[data-key]') || { dataset: {} }).dataset.key || ''); if (m) pendingFocus = { id: Number(m[1]), label: a.dataset.act }; }
    for (const fn of listeners) fn();
    if (pendingFocus) setTimeout(() => restoreFocus(), 60);
};
export const onQueueChanged = fn => { listeners.add(fn); };
export const queueDenied = () => denied;
/** Changes every half minute: the table's key carries it, so the lease left and the waiting times keep counting between data changes. */
export const queueTick = () => Math.floor(Date.now() / TICK_MS);

/** Read the queue. A failed read keeps what was shown (and says nothing: the next poll tries again). */
export async function refreshQueue() {
    if (reading) return reading;
    reading = (async () => {
        try {
            const asked = machine;
            if (asked === 'local' && isCloud()) { unavailable = HUB_WORDS; loaded = false; emit(); return; } // the Hub has no queue: each computer keeps its own (a bare read would ask the Hub itself, #13871)
            const was = unavailable;
            let r;
            try { r = asked === 'local' ? await fetch('/api/resources') : await serverFetch(asked, '/api/resources', { cache: 'no-store' }); } catch { r = null; }
            if (asked !== machine) return; // another computer was chosen while this read was out
            if (!r || !r.ok) { // said, not left on 'Reading the queue.' (#13871); a linked computer that does not answer keeps its last queue, said as such (#16030)
                unavailable = asked === 'local' ? (r ? `The queue could not be read from this computer (HTTP ${r.status}).` : '') : !r ? 'Not answering.' : r.status === 403 || r.status === 404 ? 'Does not share its queue with the hub.' : `The queue could not be read from this computer (HTTP ${r.status}).`;
                if (was !== unavailable) emit();
                return;
            }
            unavailable = '';
            const body = await r.json();
            if (asked !== machine) return;
            if (!Array.isArray(body && body.resources)) { unavailable = asked === 'local' ? '' : 'Answered with something that is not a queue.'; if (was !== unavailable) emit(); return; } // not a list: never "nothing waiting"
            const next = body.resources;
            const same = loaded && !was && JSON.stringify(next) === JSON.stringify(resources);
            resources = next; loaded = true;
            if (asked !== 'local') lastRead.set(asked, { resources: next, at: Date.now() });
            if (!same) emit();
        } catch { /* the next poll */ } finally { reading = null; }
    })();
    return reading;
}

/** Start or stop the polling: on while the Queue folder is the one on screen. */
export function watchQueue(on) {
    wanted = !!on;
    if (!wanted) { clearInterval(timer); clearInterval(tickTimer); timer = 0; tickTimer = 0; return; }
    refreshQueue();
    if (!timer) timer = pollEvery(() => { if (wanted) refreshQueue(); }, POLL_MS);
    if (!tickTimer) tickTimer = pollEvery(() => { if (wanted && !document.querySelector('.queue-sure')) emit(); }, TICK_MS); // not while a Kick is waiting for its second press: the table would be drawn again under it
}

const ago = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (Date.now() - t) / 1000 : NaN; };
const left = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (t - Date.now()) / 1000 : NaN; };
/** "Lease left 4 min" for a holder, "Lease over" when it has run out and the server has not yet ended it. */
export const leaseWords = e => { const s = left(e.lease_until); if (!Number.isFinite(s)) return ''; return s <= 0 ? 'Lease over' : `${compactDuration(s)} left`; };
/** "Waiting 3 min" for an entry in line. */
export const waitWords = e => { const s = ago(e.enqueued_at); return Number.isFinite(s) ? `Waiting ${compactDuration(s)}` : 'Waiting'; };

/** A pool's hold is on the pool's list and on its member's (the member's slot is in use): it is one row, under the pool, so the member's group leaves it out of its rows (its count of slots in use still has it). */
const ownHolders = r => (r.holders || []).filter(e => !(e.member && e.member === r.name));

/** One row per holder and per waiting entry, a resource with nobody on it as one row that says all its slots are free. */
export function queueItems() {
    const rows = [];
    for (const r of resources) {
        const holders = r.holders || [], queue = r.queue || [], head = { resource: r.name, machine: r.machine || '', slots: r.slots, used: holders.length, waiting: queue.length };
        if (!holders.length && !queue.length) rows.push({ ...head, key: `${r.name}-free`, id: 0, state: 'free', agent: '', note: '', task: 0, place: 0, last: true, first: true });
        ownHolders(r).forEach(e => rows.push({ ...head, key: `${r.name}-${e.id}`, id: e.id, state: 'holding', agent: e.agent, note: e.note || '', task: e.task || 0, project: e.project || '', goal_id: e.goal_id || 0, goal_title: e.goal_title || '', member: e.member || '', heldOn: e.machine || '', stuck: e.stuck || '', stuck_min: e.stuck_min || 0, place: 0, lease_until: e.lease_until, enqueued_at: e.enqueued_at, pinned: !!e.pinned }));
        queue.forEach((e, i) => rows.push({ ...head, key: `${r.name}-${e.id}`, id: e.id, state: 'waiting', agent: e.agent, note: e.note || '', task: e.task || 0, project: e.project || '', goal_id: e.goal_id || 0, goal_title: e.goal_title || '', place: e.place || i + 1, first: i === 0, last: i === queue.length - 1, enqueued_at: e.enqueued_at, pinned: !!e.pinned }));
    }
    return rows;
}
export const resourceWords = r => `${r.resource}: ${r.used} of ${r.slots} in use${r.waiting ? `, ${r.waiting} waiting` : ''}${r.machine ? `, on ${r.machine}` : ''}`;
export const groupOf = r => ({ key: r.resource, label: resourceWords(r) });

/** After an action the table is drawn again: the keyboard goes back to the same entry's same button (or the first one that is on, where it just went off), and after a kick to its neighbour. */
function restoreFocus(tries = 6) {
    const want = pendingFocus; if (!want) return;
    const row = document.querySelector(`:is(#group-table-view, #queue-tab-body) tr[data-key$="-${Number(want.id)}"]`);
    const btn = row && (row.querySelector(`.queue-act[data-act="${want.label}"]:not(:disabled)`) || row.querySelector('.queue-act:not(:disabled)') || row.querySelector('.dt-mail-more-toggle'));
    if (btn) { pendingFocus = null; btn.focus({ preventScroll: true }); return; }
    if (tries > 0) setTimeout(() => restoreFocus(tries - 1), 80); else pendingFocus = null;
}
async function act(method, path, body, said) {
    try {
        const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r.status === 403) { denied = true; announceNotice('Only the Operator or an Orchestrator can change the queue.', true); emit(); return; }
        if (r.status === 404) { announceNotice('That entry is already gone.'); }
        else if (!r.ok) announceNotice('The queue could not be changed.', true);
        else announceNotice(said);
    } catch { announceNotice('The queue could not be changed.', true); }
    await refreshQueue();
    emit();
    restoreFocus();
}
export const moveEntry = (row, how) => act('POST', `/api/resources/entries/${Number(row.id)}/move`, { how }, `${row.agent} moved ${how === 'first' ? 'to the front of' : how} in the line for ${row.resource}.`);
export const noteFocus = (id, label) => { pendingFocus = { id, label }; };
export const kickEntry = row => act('DELETE', `/api/resources/entries/${Number(row.id)}`, null, row.state === 'holding' ? `${row.agent} no longer holds ${row.resource}.` : `${row.agent} left the line for ${row.resource}.`);

/** The actions a row has for the person: Move first, up and down for an entry in line (first and up are off at the front, down at the back), Kick for any entry. None when the server refused once. */
export function rowActions(row) {
    if (denied || queueReadOnly() || row.state === 'free') return [];
    const out = [];
    if (row.state === 'waiting') {
        out.push({ label: 'Move first', short: 'First', title: 'Put it at the front of the line', off: row.first, run: () => moveEntry(row, 'first') },
            { label: 'Move up', short: 'Up', title: 'One place nearer the front', off: row.first, run: () => moveEntry(row, 'up') },
            { label: 'Move down', short: 'Down', title: 'One place further back', off: row.last, run: () => moveEntry(row, 'down') });
    }
    out.push({ label: 'Kick', title: row.state === 'holding' ? 'End its hold: the slot goes to the next in line' : 'Take it out of the line', kick: true, run: () => kickEntry(row) });
    return out;
}

/** The buttons of a desktop row: each named for the agent and resource; Kick asks once more (the button becomes "Confirm kick" for a few seconds). */
export function actionsCell(row) {
    const acts = rowActions(row);
    if (!acts.length) return '';
    const box = DT.el('span', 'queue-actions');
    for (const a of acts) {
        const b = DT.el('button', 'btn btn-quiet btn-small queue-act', a.short || a.label); b.type = 'button'; b.disabled = !!a.off; b.dataset.act = a.label;
        const name = `${a.label}: ${row.agent}, ${row.resource}`;
        b.setAttribute('aria-label', name); if (a.title) b.title = a.title;
        b.addEventListener('click', e => {
            e.stopPropagation();
            if (!a.kick) { noteFocus(row.id, a.label); a.run(); return; }
            if (b.dataset.sure) { clearTimeout(Number(b.dataset.sure)); delete b.dataset.sure; b.classList.remove('queue-sure'); noteFocus(...neighbour(row)); a.run(); return; }
            // the first press arms it: the button says so (its name too) and the line is announced; ten seconds to confirm
            b.textContent = 'Confirm kick'; b.classList.add('queue-sure'); b.setAttribute('aria-label', `Confirm kick: ${row.agent}, ${row.resource}`);
            announceNotice(`Press Confirm kick to remove ${row.agent} from ${row.resource}.`);
            b.dataset.sure = String(setTimeout(() => { delete b.dataset.sure; b.textContent = 'Kick'; b.classList.remove('queue-sure'); b.setAttribute('aria-label', name); }, 10000));
        });
        box.append(b);
    }
    return box;
}
/** Where the keyboard goes after a kick: the next entry of the same resource, else the one before it. */
function neighbour(row) {
    const same = queueItems().filter(r => r.resource === row.resource && r.state !== 'free' && r.id !== row.id), after = same.find(r => r.state === 'waiting' && r.place > row.place) || same[same.length - 1] || null;
    return after ? [after.id, 'Kick'] : [row.id, 'Kick'];
}

/** A holder the Orchestrator was told is stuck (#13705): at a prompt for a person, or idle, while others wait. */
const stuckWords = r => (r.stuck === 'prompt' ? `At a prompt waiting for a person for ${r.stuck_min} min` : `Idle for ${r.stuck_min} min`);
/** What a holder says of itself: Holding, or Stuck N min when the Orchestrator was told, and on a pool's hold the machine it got (#13719), so a phone card and a desktop chip say the same. */
const holdWord = row => `${row.stuck ? `Stuck ${row.stuck_min} min` : 'Holding'}${row.heldOn ? ' on ' + row.heldOn : ''}`;
const stateWord = row => (row.state === 'holding' ? holdWord(row) : row.state === 'waiting' ? `Waiting, place ${row.place}` : 'Free');

const openTaskPage = (r, from) => importOnce('./task_navigation.js').then(m => m.openTask(r.project, r.task, from, { from: '' }));
const openGoalPage = r => importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(r.project, r.goal_id));
const goalWords = r => `#${r.goal_id} ${r.goal_title}`;
/** The links of one row (#13704): the agent opens its chat, the task its page, the goal its page on the team's. A row with no task has no task or goal link; a task with no goal has no goal link. */
const taskLink = r => (queueReadOnly() ? (r.task ? DT.el('span', '', `#${r.task}`) : '') : r.task && r.project ? DT.link(`#${r.task}`, ev => openTaskPage(r, ev && ev.currentTarget)) : r.task ? DT.el('span', '', `#${r.task}`) : '');
const goalLink = r => { if (queueReadOnly()) return r.goal_id ? DT.el('span', 'queue-goal', goalWords(r)) : ''; if (!(r.goal_id && r.project)) return ''; const b = DT.link(goalWords(r), () => openGoalPage(r)); b.classList.add('queue-goal'); b.title = goalWords(r); b.setAttribute('aria-label', `Open goal ${goalWords(r)}`); return b; };

/** On a phone the row is a card: the links are its first actions (Agent, Task, Goal), each a button with its own name. */
const linkActions = r => (r.state === 'free' || queueReadOnly() ? [] : [
    ...(liveAgentOf(r.agent, { board: r.project }) ? [{ label: `Open ${r.agent}`, title: `Open ${r.agent}`, run: () => openAgent(liveAgentOf(r.agent, { board: r.project })) }] : []),
    ...(r.task && r.project ? [{ label: `Task #${r.task}`, title: `Open task #${r.task}`, link: true, run: () => openTaskPage(r, null) }] : []),
    ...(r.goal_id && r.project ? [{ label: `Goal #${r.goal_id}`, title: `Open goal ${goalWords(r)}`, link: true, run: () => openGoalPage(r) }] : [])]);

/** The Queue folder's table. */
export function queueTable(rows, narrowed) {
    return { title: 'Queue (experimental)', noun: ['entry', 'entries'], rows,
        empty: { line: narrowed ? 'No entry matches the search.' : unavailable ? unavailable : loaded ? 'No resource is defined.' : 'Reading the queue.', hint: narrowed || !loaded || unavailable ? '' : 'An Orchestrator defines a resource with coral-board resource; agents claim a slot before a heavy run and wait in line when it is taken.' },
        signature: JSON.stringify([machine, denied, unavailable, loaded, rows.map(r => [r.key, r.state, r.place, r.agent, r.project, r.goal_id, r.goal_title, r.stuck, r.stuck_min, r.member, r.heldOn, r.note, r.used, r.slots, r.waiting, r.lease_until, r.first, r.last, r.state === 'holding' ? leaseWords(r) : r.state === 'waiting' ? waitWords(r) : ''])]), // the words of the clock are in it: the table is drawn again when they change
        node: () => DT.dataTable({
            label: `Queue, ${rows.length}`, rows, oneLine: true, resize: true, keepOrder: true, rowKey: r => r.key, rowName: r => (r.state === 'free' ? `${r.resource}, all free` : `${r.agent}, ${stateWord(r)}, ${r.resource}`),
            groupBy: groupOf,
            columns: [ // a narrow list drops the note (62 rem), then the task and the time (52): the data_table.css steps are 62, 52, 36, 28 and 16, no other number hides a column
                { key: 'agent', label: 'Agent', primary: true, width: 'grow', cell: r => (r.state === 'free' ? DT.el('span', 'dt-time', 'All slots free') : queueReadOnly() ? DT.el('span', 'queue-agent', r.agent) : agentLink(r.agent, { board: r.project, cls: 'queue-agent' })) },
                { key: 'state', label: 'State', width: '8.5rem', cell: r => (r.state === 'free' ? '' : (() => { const c = DT.chip(stateWord(r), r.state === 'holding' && !r.stuck ? 'goal-state-task-active' : ''); if (r.stuck) c.title = stuckWords(r) + '. The Orchestrator has been told.'; return c; })()) },
                { key: 'why', label: 'Note', width: '12rem', dropAt: 62, tone: 'tertiary', cell: r => r.note || '' },
                { key: 'task', label: 'Task', width: '5rem', dropAt: 52, cell: taskLink },
                { key: 'goal', label: 'Goal', width: '9rem', dropAt: 52, cell: goalLink },
                { key: 'time', label: 'Lease left / waited', width: '9rem', dropAt: 52, tone: 'tertiary', cell: r => (r.state === 'holding' ? leaseWords(r) : r.state === 'waiting' ? waitWords(r) : '') },
                ...(denied || queueReadOnly() ? [] : [{ key: 'actions', label: 'Move or kick', width: '14rem', cell: actionsCell }]),
            ],
            mail: r => ({ lead: { icon: r.state === 'holding' ? 'lock' : r.state === 'waiting' ? 'hourglass_empty' : 'check_circle', square: true, name: stateWord(r) }, title: r.state === 'free' ? `${r.resource}: all slots free` : r.agent,
                snippet: r.state === 'free' ? '' : `${r.resource}${r.note ? ' · ' + r.note : ''}`, state: stateWord(r), time: r.state === 'holding' ? `${holdWord(r)} \u00b7 ${leaseWords(r)}` : r.state === 'waiting' ? `Place ${r.place} \u00b7 ${waitWords(r)}` : '',
                actions: [...linkActions(r), ...rowActions(r)].map(a => ({ label: a.label, title: a.title, off: a.off, ...(a.kick ? { confirm: 'Confirm kick', onArm: () => announceNotice(`Press Confirm kick to remove ${r.agent} from ${r.resource}.`) } : {}), run: () => { noteFocus(a.kick ? neighbour(r)[0] : r.id, a.label); a.run(); } })) }),
        }).el };
}

/** The Automations folder that was the queue's home (#16030): the queue has its own tab, and this is the link to it. */
export const movedTable = () => ({ title: 'Queue', noun: ['entry', 'entries'], rows: [], signature: 'moved',
    empty: { line: 'The resource queue has its own tab.', hint: 'It shows the queue of this computer and of each linked one.', go: { action: 'queue-tab-open', label: 'Open the Queue tab' } } });
registerActions({ 'queue-tab-open': () => window.switchNavTab?.('queue') });

