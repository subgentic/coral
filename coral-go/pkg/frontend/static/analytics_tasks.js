/* The Analytics Tasks view (#17206, the Operator's "how many tasks is each agent completing"): tasks completed in the period, counted the way usage is: a line a group over the days (hours for a day), above a table that is
 * its legend: one row a group with the line's swatch, tasks completed, failed, the median time from claim to done, and tokens and cost per task where the board kept them. Reads GET /api/analytics/tasks (counts and
 * names only); analytics_tabs.js loads this module when the tab is opened, so the start's bytes do not change. Everything is built with the DOM and textContent: names are written by agents. */
import { importOnce } from './import_once.js';
const V = await importOnce('./analytics_viz.js');
const D = await importOnce('./analytics_tabs_data.js');
const { el } = V;
const SHOWN = 7; // the lines drawn one by one; the rest are summed into one "Other"
const BY = { agent: 'agent', team: 'team', provider: 'agent type', model: 'model' };

export const GROUPS = [['agent', 'Agent'], ['team', 'Team'], ['provider', 'Agent type'], ['model', 'Model']];
export const durWords = (s) => {
    if (s == null) return '—';
    const m = Math.round(s / 60);
    if (m < 1) return 'under a minute';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : r ? `${h} h ${r} min` : `${h} h`;
};

/** The groups as drawn: the first SHOWN, then the rest as one "Other" (its time and per-task figures are not a sum, so they are left blank). */
export function shownGroups(groups) {
    if (groups.length <= SHOWN + 1) return groups;
    const rest = groups.slice(SHOWN), n = rest[0].series.length;
    const other = { key: '__other', label: `Other (${rest.length})`, completed: 0, failed: 0, series: Array(n).fill(0) };
    for (const g of rest) { other.completed += g.completed; other.failed += g.failed; g.series.forEach((v, i) => { other.series[i] += v; }); }
    return [...groups.slice(0, SHOWN), other];
}

const bucketLabel = (iso, bucket) => (bucket === 'hour' ? iso.slice(11, 13) + ':00' : D.dayLabel(iso.slice(0, 10)));

function swatchCell(i, text) {
    const wrap = el('span', 'atab-tname'), sw = el('i', 'atab-sw' + (V.striped(i) ? ' atab-sw-stripe' : ''));
    sw.style.setProperty('--c', V.seriesColor(i)); sw.setAttribute('aria-hidden', 'true');
    wrap.append(sw, document.createTextNode(text));
    return wrap;
}

/** The page's content for one read: an array of nodes. `opts.group` names the grouping, `opts.reviews` is the review-tasks switch's state. */
export function drawTasks(data, { phone = false, group = 'agent', onReviews = null } = {}) {
    const out = [], c = data.total || { completed: 0, failed: 0 }, buckets = data.buckets || [];
    const perDay = buckets.length ? c.completed / (data.bucket === 'hour' ? 1 : buckets.length) : 0;
    out.push(V.kpiStrip([
        { label: 'Tasks completed', value: D.fmtCount(c.completed), note: data.include_reviews ? 'reviews included' : 'reviews left out' },
        { label: 'Failed', value: D.fmtCount(c.failed), note: 'completed with the outcome failed' },
        { label: data.bucket === 'hour' ? 'Tasks completed' : 'A day, on average', value: data.bucket === 'hour' ? D.fmtCount(c.completed) : (perDay >= 10 ? String(Math.round(perDay)) : perDay.toFixed(1)), note: data.bucket === 'hour' ? 'in the last 24 hours' : `over ${buckets.length} days` },
    ]));
    const groups = shownGroups(data.groups || []);
    if (!groups.length) {
        out.push(V.panel('Tasks completed over time', `a ${data.bucket} by ${BY[group]}`, el('p', 'atab-say', 'No task was completed in this period. A task counts when an agent completes it on a board; a cancelled one does not.')));
        return out;
    }
    const chart = V.multiLine(buckets.map(b => bucketLabel(b, data.bucket)), groups.map(g => ({ name: g.label, values: g.series })), { fmt: D.fmtCount, phone });
    const rows = groups.map((g, i) => [swatchCell(i, g.label), D.fmtCount(g.completed), D.fmtCount(g.failed), durWords(g.median_seconds),
        g.tokens_per_task == null ? '—' : D.fmtCount(Math.round(g.tokens_per_task)), g.cost_per_task == null ? '—' : D.fmtMoney(g.cost_per_task)]);
    const table = V.plainTable([GROUPS.find(x => x[0] === group)[1], 'Completed', 'Failed', 'Median time', 'Tokens per task', 'Cost per task'], rows, { right: [1, 2, 3, 4, 5], label: `Tasks completed, by ${BY[group]}` });
    out.push(V.panel('Tasks completed over time', `a ${data.bucket}, by ${BY[group]}`, chart, table,
        el('p', 'atab-hint', 'Completed counts every task finished on a board in the period, failed ones too. Median time runs from claim to done, review not counted.')));
    return out;
}
