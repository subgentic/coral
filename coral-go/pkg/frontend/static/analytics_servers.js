/* The Overview's "By computer" table (#16017, the Operator's ask of 2026-11-12): on a dashboard that links other computers, the spend of this one and of each linked one, side by side: cost, input and output tokens, agents
 * and requests, read from each computer (GET /api/token-usage/summary?include=totals through the Hub). A computer that does not answer shows the last figures read from it for this same range, with when it was last seen,
 * never a zero; one never read has no figures and says so. The total is the sum of the rows shown: every figure is a whole number or a cost rounded the way it is shown, so what is added is what is read. The Overview's
 * own cards stay this computer's. Lazy: cost_dashboard.js imports it. Everything is built with the DOM and textContent: a computer's name is written by its owner. */
import { state } from './state.js';
import { serverFetch } from './server_base.js';
import { formatLastSeen } from './server_status.js';
import { browserLocal } from './safe_storage.js';
import { importOnce } from './import_once.js';
const { machineChoices, machineLabel, machineOnline } = await importOnce('./analytics_machine.js');
const { dataTable, tableState, el } = await importOnce('./data_table.js');

const STORE_KEY = 'coral-by-computer';
const COST_UNIT = 1e4; // a cost is kept in ten-thousandths of a dollar: the cent, or the four places a cost under a cent is shown with

/** A cost in ten-thousandths, rounded the way it is shown: whole cents from a cent up, four places below. */
export function costUnits(usd) {
    const u = Math.round((Number(usd) || 0) * COST_UNIT);
    return u >= 100 ? Math.round(u / 100) * 100 : u;
}
/** A cost in ten-thousandths as it reads: cents when it is whole cents, four places otherwise (so a sum of shown rows is the shown total). */
export const showUnits = u => '$' + (u / COST_UNIT).toFixed(u % 100 === 0 ? 2 : 4);

const whole = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** The figures of one /api/token-usage/summary answer, or null when it is not one (a missing or malformed total is a failed read, never zeros). */
export function figuresOf(summary) {
    const t = summary && typeof summary === 'object' ? summary.totals : null;
    if (!t || typeof t !== 'object') return null;
    const input = whole(t.input_tokens), output = whole(t.output_tokens), agents = whole(t.num_sessions), requests = whole(t.num_requests);
    const cost = typeof t.cost_usd === 'number' && Number.isFinite(t.cost_usd) && t.cost_usd >= 0 ? costUnits(t.cost_usd) : null;
    if ([input, output, agents, requests, cost].some(v => v === null)) return null;
    return { cost, input, output, agents, requests };
}

/** The table's rows and total. computers: [{ id, label, online, lastSeen }] in the order shown; known: Map id -> { figs, at } (the last good read for this range); fresh: the ids read just now.
 *  A row is 'live' (read now), 'last-known' (not answering; the last figures) or 'none' (never read: no figures). The total adds the rows that have figures; `without` names those that have none. */
export function breakdown(computers, known, fresh, now = Date.now()) {
    const rows = computers.map(c => {
        const k = known.get(c.id);
        if (fresh.has(c.id) && k) return { id: c.id, label: c.label, state: 'live', figs: k.figs, seen: 'now', at: k.at };
        if (k) return { id: c.id, label: c.label, state: 'last-known', figs: k.figs, seen: formatLastSeen(c.lastSeen || new Date(k.at).toISOString(), now), at: k.at };
        return { id: c.id, label: c.label, state: 'none', figs: null, seen: c.lastSeen ? formatLastSeen(c.lastSeen, now) : 'never', at: 0 };
    });
    const total = { cost: 0, input: 0, output: 0, agents: 0, requests: 0 };
    for (const r of rows) if (r.figs) for (const k of Object.keys(total)) total[k] += r.figs[k];
    return { rows, total, stale: rows.filter(r => r.state === 'last-known').map(r => r.label), without: rows.filter(r => r.state === 'none').map(r => r.label) };
}

// ── what was last read, per computer and range: in memory, and in this browser so a reload keeps it ──
const memory = new Map(); // `${id}|${period}` -> { figs, at }
const keyOf = (id, period) => `${id}|${period}`;
function loadStored() {
    try { const o = JSON.parse(browserLocal.get(STORE_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function remember(id, period, figs, at) {
    memory.set(keyOf(id, period), { figs, at });
    try { const o = loadStored(); o[keyOf(id, period)] = { figs, at }; const keys = Object.keys(o); if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete o[k]; browserLocal.set(STORE_KEY, JSON.stringify(o)); } catch { /* this browser keeps nothing: the figures last until the page is closed */ }
}
function recall(id, period) {
    const hit = memory.get(keyOf(id, period));
    if (hit) return hit;
    const s = loadStored()[keyOf(id, period)];
    const figs = s && figuresOf({ totals: { input_tokens: s.figs && s.figs.input, output_tokens: s.figs && s.figs.output, num_sessions: s.figs && s.figs.agents, num_requests: s.figs && s.figs.requests, cost_usd: s.figs && typeof s.figs.cost === 'number' ? s.figs.cost / COST_UNIT : NaN } });
    if (!figs || typeof s.at !== 'number') return null;
    memory.set(keyOf(id, period), { figs, at: s.at });
    return memory.get(keyOf(id, period));
}

const computersNow = () => machineChoices().map(id => ({ id, label: machineLabel(id), online: machineOnline(id), lastSeen: id === 'local' ? '' : ((state.servers || []).find(s => s && s.id === id) || {}).last_seen || '' }));

let reading = null, seq = 0;
const tstate = tableState();
const num = n => n.toLocaleString('en-US');

/** Reads every computer's totals for the range and draws the table in host. sinceParam is the page's own range ('' or '?since=...'), period its name (the last figures are kept per period). */
export async function showByComputer(host, sinceParam, period) {
    const section = host && host.closest('[data-cview]');
    const computers = computersNow();
    if (!host || !computers.length) { if (section) { section.dataset.empty = '1'; section.hidden = true; } return false; } // one computer: nothing to compare
    if (section) { delete section.dataset.empty; section.hidden = section.dataset.cview !== state.analyticsView; }
    const mine = ++seq;
    const query = (sinceParam ? sinceParam + '&' : '?') + 'include=totals';
    const fresh = new Set();
    const wasReading = reading;
    reading = Promise.all(computers.map(async c => {
        try {
            const r = await serverFetch(c.id, '/api/token-usage/summary' + query, { cache: 'no-store' });
            const figs = r.ok ? figuresOf(await r.json()) : null;
            if (figs) { remember(c.id, period, figs, Date.now()); fresh.add(c.id); }
        } catch { /* not answering: its last figures stay */ }
    }));
    await reading; if (wasReading) await wasReading.catch(() => {});
    if (mine !== seq) return true; // a later read is drawing
    const known = new Map(computers.map(c => [c.id, recall(c.id, period)]).filter(([, v]) => v));
    draw(host, breakdown(computers, known, fresh));
    return true;
}

function draw(host, b) {
    const dash = '—';
    const f = (get, fmt) => r => (r.figs ? fmt(get(r.figs)) : dash);
    const numCol = (key, label, get, fmt, extra) => ({ key, label, numeric: true, sort: 'number', firstDir: 'desc', sortValue: r => (r.figs ? get(r.figs) : -1), cell: f(get, fmt), ...extra });
    const columns = [
        { key: 'label', label: 'Computer', sort: true, sortValue: r => r.label.toLowerCase(), cell: r => r.label, tone: 'primary' },
        numCol('cost', 'Cost', x => x.cost, showUnits, { foldFirst: true }),
        numCol('input', 'Input', x => x.input, num), numCol('output', 'Output', x => x.output, num),
        numCol('agents', 'Agents', x => x.agents, num), numCol('requests', 'Requests', x => x.requests, num),
        { key: 'seen', label: 'Last seen', sort: false, cell: r => (r.state === 'live' ? 'now' : r.state === 'none' ? (r.seen === 'never' ? 'no figures yet' : `no figures yet, seen ${r.seen}`) : `last seen ${r.seen}`) },
    ];
    const keepOrder = b.rows; // this computer first, then each linked one by name, as the Overview's own list of computers has them
    const t = dataTable({ label: 'Spend by computer', rowKey: r => r.id, state: tstate, fold: 'labeled', scroll: true, columns, rows: keepOrder, keepOrder: true,
        decorate: (r, tr) => { tr.dataset.computer = r.id; tr.dataset.state = r.state; if (r.state === 'last-known') tr.title = `The last figures read from ${r.label}, at ${new Date(r.at).toLocaleString()}.`; } });
    const total = el('div', 'cost-by-computer-total'); total.dataset.total = '1';
    total.append(el('span', 'cost-by-computer-total-label', b.rows.length === 1 ? 'Total' : 'Total of the computers above'),
        el('span', 'cost-by-computer-total-figs', `${showUnits(b.total.cost)} · ${num(b.total.input)} in · ${num(b.total.output)} out · ${num(b.total.agents)} agents · ${num(b.total.requests)} requests`));
    host.replaceChildren(t.el, total);
    const notes = [];
    if (b.stale.length) notes.push(`${b.stale.join(', ')} ${b.stale.length === 1 ? 'is' : 'are'} not answering: the figures shown are the last ones read, and they are in the total.`);
    if (b.without.length) notes.push(`${b.without.join(', ')} ${b.without.length === 1 ? 'has' : 'have'} given no figures yet, so ${b.without.length === 1 ? 'it adds' : 'they add'} nothing to the total. That is not a zero.`);
    for (const n of notes) { const p = el('p', 'cost-note cost-by-computer-note', n); host.append(p); }
}

/** For tests: forget what was read. */
export function forgetReads() { memory.clear(); try { browserLocal.remove(STORE_KEY); } catch { /* none */ } }
