/* The Cost page's Waste card (#21127, feature bets stage 2, task 9; the approved mock #21055): per agent, how much of the input was the earlier conversation read again, how often the prompt cache
 * expired while the agent sat idle, and how often the conversation was compacted while idle. It reads GET /api/analytics/waste (names and counts only, the Operator's alone, this computer only: through
 * Coral Hub the card is not drawn). The range is the page's own; the Team select in the page bar narrows it. A figure the agent's vendor does not report is "Not reported", never a zero.
 * Everything is built with the DOM and textContent: an agent's name is written by its owner. */
import { importOnce } from './import_once.js';
import { isCloud } from './server_base.js';
const { dataTable, tableState, el } = await importOnce('./data_table.js');
const { daysFor } = await importOnce('./analytics_limit_waits.js');

export const WASTE_NOTE = 'Input an agent paid for again without learning anything new. Counted per agent from the transcripts Coral already reads.';
export const WASTE_TERMS = [
    ['Re-read', 'share of input tokens that were the earlier conversation read again.'],
    ['Cache expiry', 'the agent sat idle past the cache time, so the next turn paid full price.'],
    ['Idle compaction', 'the conversation was summarised while the agent was idle.'],
];
export const NOT_REPORTED = 'Not reported';

const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const share = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1, v) : 0);

/** "71%" for a share of 0..1. */
export const percent = v => `${Math.round(share(v) * 100)}%`;

/** What an answer of the read becomes for the card, or null when it is not one (an answer without its totals is a failed read, never zeros). */
export function wasteModel(data) {
    if (!data || typeof data !== 'object' || !data.totals || typeof data.totals !== 'object' || !Array.isArray(data.rows)) return null;
    const rows = data.rows.filter(r => r && typeof r.agent === 'string').map(r => ({ agent: r.agent, reread: share(r.reread_share), expiries: count(r.cache_expiries), compactions: count(r.idle_compactions) }));
    return { totals: { reread: share(data.totals.reread_share), expiries: count(data.totals.cache_expiries), compactions: count(data.totals.idle_compactions) }, rows };
}

const state = { table: tableState(), seq: 0 };
const num = v => (v === null ? NOT_REPORTED : String(v));

function say(host, text, role) {
    const p = el('p', 'empty-state empty-state-tight lw-say', text);
    if (role) p.setAttribute('role', role);
    host.replaceChildren(p);
}

function kpi(value, label) {
    const k = el('div', 'lw-kpi');
    k.append(el('b', '', value), el('span', 'lw-note', label));
    return k;
}

/** The card for a model: the heading, the sentence, the three figures, the per-agent table and the line saying what each means. */
export function wasteCard(m) {
    const card = el('div', 'lw-card');
    card.append(el('div', 'lw-sec', 'Waste'), el('p', 'lw-note', WASTE_NOTE));
    const kpis = el('div', 'lw-kpis');
    kpis.append(kpi(percent(m.totals.reread), 're-read'), kpi(num(m.totals.expiries), 'cache expiries'), kpi(num(m.totals.compactions), 'idle compactions'));
    card.append(kpis);
    const cols = [
        { key: 'agent', label: 'Agent', primary: true, field: 'agent' },
        { key: 'reread', label: 'Re-read', cell: r => percent(r.reread), align: 'end' },
        { key: 'expiries', label: 'Cache expiries', cell: r => num(r.expiries), align: 'end' },
        { key: 'compactions', label: 'Idle compactions', cell: r => num(r.compactions), align: 'end' },
    ];
    card.append(dataTable({
        label: 'Waste per agent', columns: cols, rows: m.rows, rowKey: r => r.agent, keepOrder: true, fold: 'labeled', state: state.table,
        empty: { line: 'No agent used input in this range.' },
    }).el);
    const terms = el('p', 'lw-note');
    WASTE_TERMS.forEach(([term, text], i) => { if (i) terms.append(' '); terms.append(el('b', '', term), `: ${text}`); });
    card.append(terms);
    return card;
}

/** Reads the range's waste and draws the card into host. A later call supersedes an earlier one that has not answered. */
export async function showWaste(host, period) {
    const section = host && host.closest('.cost-section');
    if (!host) return;
    if (isCloud()) { if (section) section.hidden = true; return; } // this computer's own record: not through Coral Hub
    if (section) section.hidden = false;
    const sel = document.getElementById('cost-team');
    const team = sel ? sel.value : '';
    const mine = ++state.seq;
    let data = null;
    try {
        const resp = await fetch(`/api/analytics/waste?days=${daysFor(period)}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
        if (mine !== state.seq) return;
        if (resp.status === 403) { say(host, 'The waste figures are for the person at this computer only.', 'status'); return; }
        data = resp.ok ? wasteModel(await resp.json().catch(() => null)) : null;
    } catch { data = null; }
    if (mine !== state.seq) return;
    if (!data) { say(host, 'The waste figures could not be read. Refresh to try again.', 'status'); return; }
    host.replaceChildren(wasteCard(data));
}
