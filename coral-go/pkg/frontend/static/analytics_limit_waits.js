/* The Cost page's Limit waits card (#21020, feature bets stage 1; the approved mock #21017): how often an agent was stopped by its vendor's usage limit and how it went on, per agent and day. It reads
 * GET /api/analytics/limit-waits (names and counts only, the Operator's alone, this computer only: through Coral Hub the card is not drawn). The range is the page's own; the Team select in the page bar
 * (beside the range, as in the mock) filters this card. A wait counts on the day it began, and so does how it ended; "early" is a resume before the reset time the vendor gave, whoever made it.
 * Everything is built with the DOM and textContent: an agent's name is written by its owner. */
import { importOnce } from './import_once.js';
import { isCloud } from './server_base.js';
const { dataTable, tableState, el } = await importOnce('./data_table.js');

export const LIMIT_WAITS_NOTE = 'When an agent hits its vendor limit it waits, then resumes at the reset time or earlier. Counted per agent and day.';
export const LIMIT_WAITS_EARLY = '"Early" means Coral or you resumed the agent before the reset time the vendor gave.';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The range of the page's select as days: the card counts whole days, so an hour or a day is today. */
export const daysFor = period => ({ hour: 1, day: 1, week: 7, month: 30 })[period] || 7;

/** "2026-11-23" as "Mon 23 Nov" (the day itself, with no time zone in it). */
export function dayWords(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return String(day || '');
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${WEEKDAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]}`;
}

const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** What an answer of the read becomes for the card, or null when it is not one (an answer without its totals is a failed read, never zeros). */
export function limitWaitsModel(data) {
    if (!data || typeof data !== 'object' || !data.totals || typeof data.totals !== 'object' || !Array.isArray(data.rows)) return null;
    const rows = data.rows.filter(r => r && typeof r.agent === 'string').map(r => ({ agent: r.agent, day: String(r.day || ''), waits: count(r.waits), atReset: count(r.at_reset), early: count(r.early) }));
    return {
        tracking: data.tracking !== false,
        totals: { waits: count(data.totals.waits), atReset: count(data.totals.at_reset), early: count(data.totals.early) },
        rows, waiting: count(data.waiting),
        teams: Array.isArray(data.teams) ? data.teams.filter(t => typeof t === 'string' && t) : [],
    };
}

const state = { table: tableState(), seq: 0, listening: false };

function say(host, text, role) {
    const p = el('p', 'empty-state empty-state-tight lw-say', text);
    if (role) p.setAttribute('role', role);
    host.replaceChildren(p);
}

function kpi(value, label) {
    const k = el('div', 'lw-kpi');
    k.append(el('b', '', String(value)), el('span', 'lw-note', label));
    return k;
}

/** The card for a model: the heading, the sentence, the three counts, the per-agent-and-day table and the note on "early". */
export function limitWaitsCard(m) {
    const card = el('div', 'lw-card');
    card.append(el('div', 'lw-sec', 'Limit waits'), el('p', 'lw-note', LIMIT_WAITS_NOTE));
    const kpis = el('div', 'lw-kpis');
    kpis.append(kpi(m.totals.waits, 'limit waits'), kpi(m.totals.atReset, 'resumed at reset'), kpi(m.totals.early, 'resumed early'));
    card.append(kpis);
    const cols = [
        { key: 'agent', label: 'Agent', primary: true, field: 'agent', sort: true },
        { key: 'day', label: 'Day', cell: r => dayWords(r.day), sortValue: r => r.day, sort: 'date', firstDir: 'desc' },
        { key: 'waits', label: 'Waits', field: 'waits', align: 'end', sort: 'number' },
        { key: 'atReset', label: 'At reset', field: 'atReset', align: 'end', sort: 'number' },
        { key: 'early', label: 'Early', field: 'early', align: 'end', sort: 'number' },
    ];
    const table = dataTable({
        label: 'Limit waits per agent and day', columns: cols, rows: m.rows, rowKey: r => `${r.agent}|${r.day}`, keepOrder: true, fold: 'labeled', state: state.table,
        empty: { line: m.tracking ? 'No agent was stopped by a limit in this range.' : 'Limit waits are not being counted on this computer.' },
    });
    card.append(table.el);
    card.append(el('p', 'lw-note', LIMIT_WAITS_EARLY));
    return card;
}

const teamSelect = () => document.getElementById('cost-team');

/** Fills the Team select with the teams of the range (keeping the choice while it is still one of them). */
function fillTeams(teams, chosen) {
    const sel = teamSelect();
    if (!sel) return;
    const keep = chosen && teams.includes(chosen) ? chosen : '';
    sel.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'All teams' }),
        ...teams.map(t => Object.assign(document.createElement('option'), { value: t, textContent: t })));
    sel.value = keep;
}

/** Reads the range's waits and draws the card into host. A later call supersedes an earlier one that has not answered. */
export async function showLimitWaits(host, period) {
    const section = host && host.closest('.cost-section');
    if (!host) return;
    if (isCloud()) { if (section) section.hidden = true; return; } // this computer's own record: not through Coral Hub
    if (section) section.hidden = false;
    const sel = teamSelect();
    if (sel && !state.listening) { state.listening = true; sel.addEventListener('change', () => showLimitWaits(host, document.getElementById('cost-time-range')?.value || period)); }
    const team = sel ? sel.value : '';
    const mine = ++state.seq;
    let data = null;
    try {
        const resp = await fetch(`/api/analytics/limit-waits?days=${daysFor(period)}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
        if (mine !== state.seq) return;
        if (resp.status === 403) { say(host, 'The limit waits are for the person at this computer only.', 'status'); return; }
        data = resp.ok ? limitWaitsModel(await resp.json().catch(() => null)) : null;
    } catch { data = null; }
    if (mine !== state.seq) return;
    if (!data) { say(host, 'The limit waits could not be read. Refresh to try again.', 'status'); return; }
    fillTeams(data.teams, team);
    host.replaceChildren(limitWaitsCard(data));
}
