/* The Analytics tab's efficiency views (Goal #77, the Operator's approved mock): "Tokens per commit" and "Task time" each have a Group by switch, All, Provider, Model, Thinking level, Team, Agent, Branch, Task.
 * All is the view the section always had (one team, over time: analytics_spend.js); every other grouping is the comparison across the teams on this computer: three cards (the most efficient group, the
 * average or the cheapest, the count), ranked bars with the average as a line, and a table. A group with fewer than `min_sample` commits or tasks is shown, hatched and tagged "few", and is never called the
 * most efficient. One read: GET /api/analytics/efficiency?metric=tokens_per_commit|task_time&group_by=<group>&range=24h|7d|30d (this computer's data). Everything is built with the DOM and textContent: names
 * are written by agents. Lazy: cost_dashboard.js imports it. */
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';

const { dataTable } = await importOnce('./data_table.js'); // the shared table
const { fmtTokens, fmtDur } = await importOnce('./analytics_spend.js'); // a figure as a person reads it

const GROUPS = [['all', 'All'], ['provider', 'Provider'], ['model', 'Model'], ['thinking', 'Thinking level'], ['team', 'Team'], ['agent', 'Agent'], ['branch', 'Branch'], ['task', 'Task']];
const PROVIDER_VAR = { claude: '--viz-2', codex: '--viz-1', pi: '--viz-3', agy: '--viz-7', gemini: '--viz-4' }; // a provider keeps its colour in every grouping that names it
const SECTIONS = {
    'per-commit': { section: 'cost-spend-section', old: 'cost-spend', metric: 'tokens_per_commit', unit: 'commit', units: 'commits', value: v => `${fmtTokens(v)}`, low: 'cheaper', best: 'Most efficient', word: 'tokens per commit', key: 'coral-eff-group-commit' },
    'task-time': { section: 'cost-task-time-section', old: 'cost-task-time', metric: 'task_time', unit: 'task', units: 'tasks', value: v => fmtDur(v), low: 'faster', best: 'Fastest', word: 'median task time', key: 'coral-eff-group-time' },
};
const groupsOf = cfg => (cfg.metric === 'task_time' ? GROUPS.filter(g => g[0] !== 'task') : GROUPS); // every task is a group of one: a task has no comparison to make with itself
const state = {}; // view key -> { group, data, loading, error, seq }
let range = '24h';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = v => (num(v) == null ? '' : v > 0 && v < 0.01 ? '<$0.01' : `$${v >= 100 ? Math.round(v) : v.toFixed(2)}`);
/** A cost per commit or task: a group with no recorded cost says so (a $0.00 would read as free); under a cent is "<$0.01". */
const costWords = (v, unit) => (num(v) == null ? '' : v > 0 ? `${money(v)} per ${unit}` : 'no cost');
const rangeOf = period => (period === 'week' ? '7d' : period === 'month' ? '30d' : '24h');
const groupLabel = g => (GROUPS.find(x => x[0] === g) || [g, g])[1];

function provVar(g) { const p = String(g.provider || '').toLowerCase(); return PROVIDER_VAR[p] ? `var(${PROVIDER_VAR[p]})` : 'var(--viz-other)'; }

/** Build the Group by control once, above the section's own content, and the host of the comparison below it. */
function build(key) {
    const cfg = SECTIONS[key], section = document.getElementById(cfg.section);
    if (!section || section.dataset.effBuilt) return !!section;
    section.dataset.effBuilt = '1';
    let saved = 'all'; try { const v = browserLocal.get(cfg.key); if (groupsOf(cfg).some(g => g[0] === v)) saved = v; } catch { /* the choice lasts until the page closes */ }
    state[key] = { group: saved, data: null, loading: false, error: '', seq: 0 };
    const bar = el('div', 'eff-switch');
    bar.append(el('div', 'eff-switch-label', 'Group by'));
    const seg = el('div', 'eff-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Group by');
    const pick = el('select', 'cost-time-select eff-pick'); pick.setAttribute('aria-label', 'Group by'); // a phone: one select
    for (const [value, label] of groupsOf(cfg)) {
        const b = el('button', 'eff-seg-btn', label); b.type = 'button'; b.dataset.group = value; b.addEventListener('click', () => choose(key, value)); seg.append(b);
        pick.append(new Option(label, value));
    }
    pick.addEventListener('change', () => choose(key, pick.value));
    bar.append(seg, pick);
    const view = el('div', 'eff-view'); view.id = `cost-eff-${key}`; view.hidden = true;
    const title = section.querySelector('.cost-section-title');
    (title || section).after(bar); bar.after(view);
    sync(key);
    return true;
}

function choose(key, group) {
    const s = state[key], cfg = SECTIONS[key]; if (!s || s.group === group) return;
    s.group = group; s.data = null; s.error = '';
    try { browserLocal.set(cfg.key, group); } catch { /* the choice lasts until the page closes */ }
    sync(key); refresh(key);
}

/** The switch shows the group; All is the section's own content, any other is the comparison. */
function sync(key) {
    const s = state[key], cfg = SECTIONS[key], section = document.getElementById(cfg.section); if (!s || !section) return;
    for (const b of section.querySelectorAll('.eff-seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.group === s.group));
    const pick = section.querySelector('.eff-pick'); if (pick) pick.value = s.group;
    const view = document.getElementById(`cost-eff-${key}`), old = document.getElementById(cfg.old);
    if (view) view.hidden = s.group === 'all';
    if (old) old.hidden = s.group !== 'all';
    draw(key);
}

async function read(cfg, group, signal) {
    const r = await fetch(`/api/analytics/efficiency?metric=${cfg.metric}&group_by=${encodeURIComponent(group)}&range=${range}`, { signal });
    if (!r.ok) throw new Error(`Could not load the comparison (${r.status}).`);
    const d = await r.json();
    if (!d || !Array.isArray(d.groups) || d.groups.some(g => !g || typeof g.label !== 'string')) throw new Error('Could not load the comparison: unexpected answer.');
    return d;
}

let controllers = {};
function refresh(key) {
    const s = state[key], cfg = SECTIONS[key]; if (!s || s.group === 'all') return Promise.resolve();
    const mine = ++s.seq; if (controllers[key]) controllers[key].abort(); const ctrl = controllers[key] = new AbortController();
    s.loading = !s.data; s.error = ''; draw(key);
    return read(cfg, s.group, ctrl.signal).then(d => { if (mine === s.seq) { s.data = d; s.loading = false; draw(key); } }, e => { if (mine !== s.seq || e.name === 'AbortError') return; s.loading = false; s.error = e.message || 'Could not load the comparison.'; draw(key); });
}

/** The page refreshed (or the range changed): the comparison is read again for the open view. */
export function syncEfficiency(period) {
    const next = rangeOf(period), changed = next !== range; range = next;
    for (const key of Object.keys(SECTIONS)) { if (!build(key)) continue; const s = state[key]; if (changed) s.data = null; const sec = document.getElementById(SECTIONS[key].section); if (sec && !sec.hidden) refresh(key); }
}
document.addEventListener('cost-view-change', e => { const key = e.detail; if (SECTIONS[key]) { if (build(key)) refresh(key); } });

function card(label, value, detail, tone) {
    const c = el('div', 'eff-card'); c.append(el('div', 'eff-card-k', label));
    const v = el('div', 'eff-card-v', value); c.append(v);
    if (detail) c.append(el('div', `eff-card-d${tone === 'good' ? ' eff-good' : ''}`, detail));
    return c;
}

/** The sentence about what a grouping left out: a CLI named in `unmeasured` writes no usage rows ("gemini"); "unknown" is the work of no recorded session, whose provider is not recorded. */
function unmeasuredWords(list, cfg) {
    if (!Array.isArray(list) || !list.length) return '';
    const clis = list.filter(w => w !== 'unknown'), parts = [];
    if (clis.length) parts.push(`${clis.join(', ')} write${clis.length === 1 ? 's' : ''} no usage rows, so ${clis.length === 1 ? 'its' : 'their'} ${cfg.units} are left out.`);
    if (list.includes('unknown')) parts.push(`Provider not recorded: ${cfg.units} of no recorded session are left out.`);
    return parts.join(' ');
}

/** Tokens per commit by task: most tasks have one commit or none, so there is nothing to rank: a plain list, cheapest first, of the tasks that had a commit. */
function drawTaskList(view, cfg, d, groups) {
    const rows = [...groups].sort((a, b) => a.value - b.value), none = d.groups.length - groups.length;
    view.append(el('p', 'eff-hint', `Tasks with at least one commit, fewest tokens per commit first.${none ? ` ${none} task${none === 1 ? ' has' : 's have'} no commit and ${none === 1 ? 'is' : 'are'} not listed.` : ''}`));
    const columns = [
        { key: 'label', label: 'Task', tone: 'primary', cell: g => g.label },
        { key: 'value', label: 'Tokens per commit', numeric: true, cell: g => cfg.value(g.value) },
        { key: 'n', label: 'Commits', numeric: true, cell: g => String(g.n) },
        { key: 'tokens', label: 'Tokens', numeric: true, cell: g => (num(g.tokens) == null ? '—' : fmtTokens(g.tokens)) },
        { key: 'cost', label: 'Cost per commit', numeric: true, cell: g => (num(g.cost_usd_per_unit) == null ? '—' : g.cost_usd_per_unit > 0 ? money(g.cost_usd_per_unit) : 'no cost') },
    ];
    view.append(dataTable({ label: 'Tokens per commit by task', fold: 'labeled', rows, rowKey: g => g.key || g.label, columns }).el);
}

function draw(key) {
    const s = state[key], cfg = SECTIONS[key], view = document.getElementById(`cost-eff-${key}`); if (!s || !view || s.group === 'all') return;
    view.replaceChildren();
    if (s.error) { const e = el('p', 'goals-note team-artifacts-error', s.error); e.setAttribute('role', 'alert'); const b = el('button', 'btn btn-small', 'Retry'); b.type = 'button'; b.addEventListener('click', () => refresh(key)); view.append(e, b); return; }
    if (!s.data) { view.append(el('p', 'goals-note', 'Loading…')); return; }
    const d = s.data, min = num(d.min_sample) || 10, groups = d.groups.filter(g => num(g.value) != null && num(g.n) != null && g.n > 0), empty = d.groups.filter(g => !groups.includes(g)); // a group with no commits or tasks (n 0) is listed in the table, with no bar
    const isFewG = g => g.low_sample === true || g.n < min; // the endpoint says it (low_sample); older answers: under the minimum
    if (!groups.length) { view.append(el('p', 'goals-note', `No ${cfg.units} in this time range to compare.`)); return; }
    if (s.group === 'task') { drawTaskList(view, cfg, d, groups); return; }
    const ranked = groups.filter(g => !isFewG(g)).sort((a, b) => a.value - b.value), few = groups.filter(isFewG).sort((a, b) => a.value - b.value), order = [...ranked, ...few];
    const total = num(d.total && d.total.n) != null ? d.total.n : groups.reduce((n, g) => n + g.n, 0);
    const avg = num(d.average && d.average.value) != null ? d.average.value : groups.reduce((sum, g) => sum + g.value * g.n, 0) / Math.max(1, groups.reduce((n, g) => n + g.n, 0));
    const usual = num(d.average && d.average.usual);
    const avgWord = cfg.metric === 'task_time' ? 'median' : 'average'; // the answer's average of task time is the median of all tasks
    const cards = el('div', 'eff-cards');
    const best = ranked[0];
    cards.append(card(`${cfg.best} (at least ${min} ${cfg.units})`, best ? best.label : 'Not enough data', best ? `${cfg.value(best.value)} ${cfg.metric === 'task_time' ? 'median' : 'per ' + cfg.unit}${avg > 0 && best.value < avg ? `, ${Math.round((1 - best.value / avg) * 100)}% under the ${cfg.value(avg)} ${avgWord}` : ''}` : `No group has ${min} ${cfg.units} yet.`, best ? 'good' : ''));
    if (cfg.metric === 'tokens_per_commit') cards.append(card('Average, all commits', cfg.value(avg), usual != null ? `Usual last week: ${cfg.value(usual)}` : 'tokens per commit'));
    else { const cheap = ranked.filter(g => num(g.cost_usd_per_unit) > 0).sort((a, b) => a.cost_usd_per_unit - b.cost_usd_per_unit)[0]; cards.append(card('Cheapest per task', cheap ? cheap.label : 'Not enough data', cheap ? `${costWords(cheap.cost_usd_per_unit, 'task')}, ${cfg.value(cheap.value)} median` : '')); }
    cards.append(card(cfg.metric === 'task_time' ? 'Tasks done' : 'Commits counted', String(total), few.length ? `${few.length} group${few.length === 1 ? '' : 's'} below ${min} ${cfg.units}, shown but not ranked` : `every group has at least ${min} ${cfg.units}`));
    view.append(cards);

    const panel = el('section', 'eff-panel');
    panel.append(el('h4', 'eff-panel-title', `${cfg.metric === 'task_time' ? 'Median task time' : 'Tokens per commit'}, ${groupLabel(s.group).toLowerCase()}`));
    panel.append(el('p', 'eff-hint', `Bars: lower is ${cfg.low}. The line is the ${avgWord} across all ${cfg.units}. ${cfg.metric === 'task_time' ? 'Review time is not counted. ' : ''}A ${cfg.unit} belongs to the ${groupLabel(s.group).toLowerCase()} of the agent that did it.`));
    const legend = el('div', 'eff-legend');
    const provs = [...new Set(order.filter(g => g.provider).map(g => String(g.provider)))];
    if (s.group === 'provider' || s.group === 'model') for (const p of provs) { const i = el('span', 'eff-legend-item'); const sw = el('i', 'eff-swatch'); sw.style.background = `var(${PROVIDER_VAR[p.toLowerCase()] || '--viz-other'})`; i.append(sw, document.createTextNode(p)); legend.append(i); }
    if (few.length) { const i = el('span', 'eff-legend-item'); i.append(el('i', 'eff-swatch eff-swatch-few'), document.createTextNode(`fewer than ${min} (not ranked)`)); legend.append(i); }
    if (legend.children.length) panel.append(legend);
    const max = Math.max(...order.map(g => g.value), avg, 1) * 1.08, bars = el('div', 'eff-bars'); bars.setAttribute('aria-hidden', 'true'); // the table below says the same in words
    for (const g of order) {
        const isFew = isFewG(g), row = el('div', 'eff-bar');
        const lab = el('div', 'eff-bar-label', g.label); lab.append(el('small', null, `${g.n} ${g.n === 1 ? cfg.unit : cfg.units}${cfg.metric === 'task_time' && num(g.sent_back_share) != null ? ` · ${Math.round(g.sent_back_share * 100)}% sent back` : ''}${isFew ? ' · too few to rank' : ''}`));
        const track = el('div', 'eff-track'), fill = el('div', `eff-fill${isFew ? ' eff-few' : ''}`); fill.style.width = `${Math.max(1, g.value / max * 100)}%`; fill.style.background = (s.group === 'provider' || s.group === 'model') ? provVar(g) : 'var(--viz-other)';
        const line = el('div', 'eff-avg'); line.style.left = `${Math.max(0, avg) / max * 100}%`; track.append(fill, line);
        const val = el('div', 'eff-bar-value', cfg.value(g.value)); if (num(g.cost_usd_per_unit) != null) val.append(el('small', null, costWords(g.cost_usd_per_unit, cfg.unit)));
        row.append(lab, track, val); bars.append(row);
    }
    panel.append(bars);
    const left = unmeasuredWords(d.unmeasured, cfg); // what the answer says it left out: a CLI with no usage rows, tasks of no recorded session
    if (cfg.metric === 'tokens_per_commit') panel.append(el('p', 'eff-note', `Counts all tokens, cache reads included.${left ? ' ' + left : ''}`));
    else panel.append(el('p', 'eff-note', `Sent back is the share of tasks a reviewer returned for changes: fast is not efficient if the work comes back.${left ? ' ' + left : ''}`));
    view.append(panel);

    const vs = g => { if (!(avg > 0)) return '—'; const p = Math.round((g.value / avg - 1) * 100); return `${p > 0 ? '+' : ''}${p}%`; }; // an average of 0 has nothing to be above or under
    const columns = [
        { key: 'label', label: groupLabel(s.group), tone: 'primary', cell: g => { const c = document.createElement('span'); c.append(document.createTextNode(g.label)); if (g === best) c.append(el('span', 'eff-tag eff-tag-best', cfg.metric === 'task_time' ? 'fastest' : 'most efficient')); if (g.n > 0 && isFewG(g)) c.append(el('span', 'eff-tag', 'few')); if (!g.n) c.append(el('span', 'eff-tag', 'no data')); return c; } },
        { key: 'value', label: cfg.metric === 'task_time' ? 'Median time' : 'Tokens per commit', numeric: true, cell: g => (num(g.value) == null ? '—' : cfg.value(g.value)) },
        { key: 'vs', label: `vs ${avgWord}`, numeric: true, cell: g => (num(g.value) == null ? '—' : vs(g)) },
        { key: 'n', label: cfg.metric === 'task_time' ? 'Tasks' : 'Commits', numeric: true, cell: g => String(num(g.n) == null ? 0 : g.n) },
        cfg.metric === 'task_time'
            ? { key: 'sent_back_share', label: 'Sent back', numeric: true, cell: g => (num(g.sent_back_share) == null ? '—' : `${Math.round(g.sent_back_share * 100)}%`) }
            : { key: 'tokens', label: 'Tokens', numeric: true, cell: g => (num(g.tokens) == null ? '—' : fmtTokens(g.tokens)) },
        { key: 'cost', label: cfg.metric === 'task_time' ? 'Cost per task' : 'Cost per commit', numeric: true, cell: g => (num(g.cost_usd_per_unit) == null ? '—' : g.cost_usd_per_unit > 0 ? money(g.cost_usd_per_unit) : 'no cost') },
    ];
    view.append(dataTable({ label: `${cfg.metric === 'task_time' ? 'Task time' : 'Tokens per commit'} by ${groupLabel(s.group).toLowerCase()}`, fold: 'labeled', rows: [...order, ...empty], rowKey: g => g.key || g.label, columns }).el);
}
