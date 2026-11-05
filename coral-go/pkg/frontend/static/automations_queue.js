/* The Queue folder of Automations (#13651, goal #225): the resource queue of this computer (GET /api/resources) as one table, each resource a group: its name, how many of its slots are in use,
 * then who holds a slot (the agent, the note the agent gave, the lease left) and the waiting line in order (the place, the note, how long it has waited). The Operator can move an entry in the
 * line (first, up, down) and kick one (a holder is told its lease is gone, a waiting entry leaves the line); the server decides (a 403 hides the buttons for good, a 404 is the entry already gone).
 * A note is the pattern the agent named, never a command: it is drawn as text and nothing here builds a command from it. Read when the folder is shown and every few seconds while it is. */
import { compactDuration } from './format.js';
import { announceNotice } from './notifications.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');

const POLL_MS = 5000;
let resources = [], loaded = false, denied = false, timer = 0, listeners = new Set(), wanted = false, reading = null;

const emit = () => { for (const fn of listeners) fn(); };
export const onQueueChanged = fn => { listeners.add(fn); };
export const queueLoaded = () => loaded;
export const queueDenied = () => denied;

/** Read the queue. A failed read keeps what was shown (and says nothing: the next poll tries again). */
export async function refreshQueue() {
    if (reading) return reading;
    reading = (async () => {
        try {
            const r = await fetch('/api/resources');
            if (!r.ok) return;
            const body = await r.json();
            const next = Array.isArray(body && body.resources) ? body.resources : [];
            const same = loaded && JSON.stringify(next) === JSON.stringify(resources);
            resources = next; loaded = true;
            if (!same) emit();
        } catch { /* the next poll */ } finally { reading = null; }
    })();
    return reading;
}

/** Start or stop the polling: on while the Queue folder is the one on screen. */
export function watchQueue(on) {
    wanted = !!on;
    if (!wanted) { clearInterval(timer); timer = 0; return; }
    refreshQueue();
    if (!timer) timer = pollEvery(() => { if (wanted) refreshQueue(); }, POLL_MS);
}

const ago = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (Date.now() - t) / 1000 : NaN; };
const left = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (t - Date.now()) / 1000 : NaN; };
/** "Lease left 4 min" for a holder, "Lease over" when it has run out and the server has not yet ended it. */
export const leaseWords = e => { const s = left(e.lease_until); if (!Number.isFinite(s)) return ''; return s <= 0 ? 'Lease over' : `${compactDuration(s)} left`; };
/** "Waiting 3 min" for an entry in line. */
export const waitWords = e => { const s = ago(e.enqueued_at); return Number.isFinite(s) ? `Waiting ${compactDuration(s)}` : 'Waiting'; };

/** One row per holder and per waiting entry, a resource with nobody on it as one row that says all its slots are free. */
export function queueItems() {
    const rows = [];
    for (const r of resources) {
        const holders = r.holders || [], queue = r.queue || [], head = { resource: r.name, machine: r.machine || '', slots: r.slots, used: holders.length, waiting: queue.length };
        if (!holders.length && !queue.length) rows.push({ ...head, key: `${r.name}-free`, id: 0, state: 'free', agent: '', note: '', task: 0, place: 0, last: true, first: true });
        holders.forEach(e => rows.push({ ...head, key: `${r.name}-${e.id}`, id: e.id, state: 'holding', agent: e.agent, note: e.note || '', task: e.task || 0, place: 0, lease_until: e.lease_until, enqueued_at: e.enqueued_at, pinned: !!e.pinned }));
        queue.forEach((e, i) => rows.push({ ...head, key: `${r.name}-${e.id}`, id: e.id, state: 'waiting', agent: e.agent, note: e.note || '', task: e.task || 0, place: e.place || i + 1, first: i === 0, last: i === queue.length - 1, enqueued_at: e.enqueued_at, pinned: !!e.pinned }));
    }
    return rows;
}
export const queueCount = () => resources.reduce((n, r) => n + (r.queue || []).length + (r.holders || []).length, 0);
export const resourceWords = r => `${r.resource}: ${r.used} of ${r.slots} in use${r.waiting ? `, ${r.waiting} waiting` : ''}${r.machine ? `, on ${r.machine}` : ''}`;
export const groupOf = r => ({ key: r.resource, label: resourceWords(r) });

async function act(method, path, body, said) {
    try {
        const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r.status === 403) { denied = true; announceNotice('Only the Operator or an Orchestrator can change the queue.', true); emit(); return; }
        if (r.status === 404) { announceNotice('That entry is already gone.'); }
        else if (!r.ok) announceNotice('The queue could not be changed.', true);
        else announceNotice(said);
    } catch { announceNotice('The queue could not be changed.', true); }
    await refreshQueue();
}
export const moveEntry = (row, how) => act('POST', `/api/resources/entries/${Number(row.id)}/move`, { how }, `${row.agent} moved ${how === 'first' ? 'to the front of' : how} in the line for ${row.resource}.`);
export const kickEntry = row => act('DELETE', `/api/resources/entries/${Number(row.id)}`, null, row.state === 'holding' ? `${row.agent} no longer holds ${row.resource}.` : `${row.agent} left the line for ${row.resource}.`);

/** The actions a row has for the person: Move first, up and down for an entry in line (first and up are off at the front, down at the back), Kick for any entry. None when the server refused once. */
export function rowActions(row) {
    if (denied || row.state === 'free') return [];
    const out = [];
    if (row.state === 'waiting') {
        out.push({ label: 'Move first', title: 'Put it at the front of the line', off: row.first, run: () => moveEntry(row, 'first') },
            { label: 'Move up', title: 'One place nearer the front', off: row.first, run: () => moveEntry(row, 'up') },
            { label: 'Move down', title: 'One place further back', off: row.last, run: () => moveEntry(row, 'down') });
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
        const b = DT.el('button', 'btn btn-quiet btn-small queue-act', a.label); b.type = 'button'; b.disabled = !!a.off;
        b.setAttribute('aria-label', `${a.label}: ${row.agent}, ${row.resource}`); if (a.title) b.title = a.title;
        b.addEventListener('click', e => {
            e.stopPropagation();
            if (!a.kick) { a.run(); return; }
            if (b.dataset.sure) { clearTimeout(Number(b.dataset.sure)); a.run(); return; }
            b.textContent = 'Confirm kick'; b.classList.add('queue-sure');
            b.dataset.sure = String(setTimeout(() => { delete b.dataset.sure; b.textContent = 'Kick'; b.classList.remove('queue-sure'); }, 4000));
        });
        box.append(b);
    }
    return box;
}

const stateWord = row => (row.state === 'holding' ? 'Holding' : row.state === 'waiting' ? `Waiting, place ${row.place}` : 'Free');

/** The Queue folder's table. */
export function queueTable(rows, narrowed) {
    return { title: 'Queue', noun: ['entry', 'entries'], rows,
        empty: { line: narrowed ? 'No entry matches the search.' : loaded ? 'No resource is defined.' : 'Reading the queue.', hint: narrowed || !loaded ? '' : 'An Orchestrator defines a resource with coral-board resource; agents claim a slot before a heavy run and wait in line when it is taken.' },
        signature: JSON.stringify([denied, rows.map(r => [r.key, r.state, r.place, r.agent, r.note, r.used, r.slots, r.waiting, r.lease_until, r.first, r.last])]),
        node: () => DT.dataTable({
            label: `Queue, ${rows.length}`, rows, oneLine: true, resize: true, keepOrder: true, rowKey: r => r.key, rowName: r => (r.state === 'free' ? `${r.resource}, all free` : `${r.agent}, ${stateWord(r)}, ${r.resource}`),
            groupBy: groupOf,
            columns: [ // a narrow list drops the note, then the task, then the time (dropAt)
                { key: 'agent', label: 'Agent', primary: true, width: 'grow', cell: r => (r.state === 'free' ? DT.el('span', 'dt-time', 'All slots free') : DT.el('span', 'queue-agent', r.agent)) },
                { key: 'state', label: 'State', width: '10rem', cell: r => (r.state === 'free' ? '' : DT.chip(stateWord(r), r.state === 'holding' ? 'goal-state-task-active' : '')) },
                { key: 'note', label: 'Note', width: '14rem', dropAt: 40, tone: 'tertiary', cell: r => r.note || '' },
                { key: 'task', label: 'Task', width: '6rem', dropAt: 52, tone: 'tertiary', cell: r => (r.task ? `#${r.task}` : '') },
                { key: 'time', label: 'Lease left / waited', width: '10rem', dropAt: 28, tone: 'tertiary', cell: r => (r.state === 'holding' ? leaseWords(r) : r.state === 'waiting' ? waitWords(r) : '') },
                ...(denied ? [] : [{ key: 'actions', label: 'Actions', width: '17rem', cell: actionsCell }]),
            ],
            mail: r => ({ lead: { icon: r.state === 'holding' ? 'lock' : r.state === 'waiting' ? 'hourglass_empty' : 'check_circle', square: true, name: stateWord(r) }, title: r.state === 'free' ? `${r.resource}: all slots free` : r.agent,
                snippet: r.state === 'free' ? '' : `${r.resource}${r.note ? ' · ' + r.note : ''}`, state: stateWord(r), time: r.state === 'holding' ? leaseWords(r) : r.state === 'waiting' ? waitWords(r) : '',
                actions: rowActions(r).map(a => ({ label: a.label, title: a.title, run: a.run })) }),
        }).el };
}

export const queueSearch = (rows, q) => { const t = String(q || '').trim().toLowerCase(); return t ? rows.filter(r => [r.resource, r.machine, r.agent, r.note, r.task ? `#${r.task}` : ''].some(s => String(s).toLowerCase().includes(t))) : rows; };
