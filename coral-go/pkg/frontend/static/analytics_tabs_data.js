/* The numbers behind the Analytics tabs Usage, Operator interaction and Team communication (#11222), with no page in them: the rows a read becomes. Pure functions, so a node test can pin them
 * (analytics_tabs.test.mjs). Counts stay counts: a figure the read did not send is null ("not recorded yet"), never zero. */

export const METRICS = [['cost', 'Cost'], ['tokens', 'Tokens'], ['requests', 'Requests']];
export const RANGES = [['7d', 'Last 7 days'], ['14d', 'Last 14 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']];
export const daysOf = (range) => ({ '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[range] || 14);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-26 -> "Oct 26" (the day is a UTC day, as the reads count them). */
export function dayLabel(day) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || '')); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : String(day || ''); }

/** The value of a bucket or series for a metric: cost in dollars, tokens as input plus output (cache beside it, never inside), requests as a count. */
export function valueOf(row, metric) {
    if (!row) return 0;
    if (metric === 'tokens') return (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
    if (metric === 'requests') return Number(row.num_requests) || 0;
    return Number(row.cost_usd) || 0;
}

/** The UTC days from `since` (a day, "2026-10-17") for `n` days, as day strings. */
export function dayList(sinceDay, n) {
    const t = Date.parse(sinceDay + 'T00:00:00Z');
    return Array.from({ length: n }, (_, i) => new Date(t + i * 86400000).toISOString().slice(0, 10));
}

/** What the daily time-series read of 2n days becomes: the n days now and the n before, the series ranked by the metric over the current days (the top 7, the rest as "Other"), one row a day, and the
 *  totals of both periods. `buckets` is the read's list (each with `series` when it was grouped). */
export function usageModel(buckets, { days, metric, today }) {
    const all = dayList(new Date(Date.parse(today + 'T00:00:00Z') - (2 * days - 1) * 86400000).toISOString().slice(0, 10), 2 * days);
    const byDay = new Map();
    for (const b of buckets || []) byDay.set(String(b.bucket).slice(0, 10), b);
    const cur = all.slice(days), prev = all.slice(0, days);
    const sum = (list, f) => list.reduce((n, d) => n + f(byDay.get(d)), 0);
    const totals = (list) => ({
        cost: sum(list, b => valueOf(b, 'cost')), tokens: sum(list, b => valueOf(b, 'tokens')), requests: sum(list, b => valueOf(b, 'requests')),
        cacheRead: sum(list, b => (b ? Number(b.cache_read_tokens) || 0 : 0)),
    });
    const rank = new Map(); // series key -> {name, total}
    for (const d of cur) for (const s of (byDay.get(d) || {}).series || []) {
        const r = rank.get(s.key) || { key: s.key, name: s.label || s.key, total: 0 };
        r.total += valueOf(s, metric); rank.set(s.key, r);
    }
    const ordered = [...rank.values()].filter(r => r.total > 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const top = ordered.slice(0, 7), rest = ordered.slice(7);
    const series = top.map(r => ({ key: r.key, name: r.name }));
    if (rest.length) series.push({ key: '__other', name: `Other (${rest.length})` });
    const restKeys = new Set(rest.map(r => r.key)), topKeys = new Set(top.map(r => r.key));
    const rows = cur.map(d => {
        const values = {};
        for (const s of (byDay.get(d) || {}).series || []) {
            if (topKeys.has(s.key)) values[s.key] = (values[s.key] || 0) + valueOf(s, metric);
            else if (restKeys.has(s.key)) values.__other = (values.__other || 0) + valueOf(s, metric);
        }
        const total = Object.values(values).reduce((n, v) => n + v, 0) || valueOf(byDay.get(d), metric); // an ungrouped bucket has only its total
        return { day: d, label: dayLabel(d), values, total, cost: valueOf(byDay.get(d), 'cost'), tokens: valueOf(byDay.get(d), 'tokens'), requests: valueOf(byDay.get(d), 'requests') };
    });
    const busiest = rows.reduce((b, r) => (r.total > (b ? b.total : 0) ? r : b), null);
    return { series, rows, cur: totals(cur), prev: totals(prev), busiest, empty: !ordered.length && !rows.some(r => r.total > 0) };
}

/** The ranked list for one day: its series by value, with the share of the day. */
export function dayRanking(row, series, metric) {
    const total = Object.values(row.values).reduce((n, v) => n + v, 0);
    return series.map((s, i) => ({ key: s.key, name: s.name, i, value: row.values[s.key] || 0, share: total > 0 ? (row.values[s.key] || 0) / total : 0 }))
        .filter(r => r.value > 0).sort((a, b) => b.value - a.value);
}

/** The one-line figure formats of the tabs. */
export const fmtMoney = (v) => (v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + (Math.round(v * 100) / 100).toFixed(2));
export function fmtCount(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'K';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
}
export const fmtMetric = (metric, v) => (metric === 'cost' ? fmtMoney(v) : fmtCount(v));
/** What a figure says when the read did not carry it: never 0 and never a dash (a 0 and a figure that was not recorded would look the same). */
export const NOT_RECORDED = 'not recorded yet';
export const countWords = (v) => (v == null ? NOT_RECORDED : String(v));
/** A wait (`which`: median_s or slowest_s) of a set of asks: not recorded when the read had no asks field, and a plain sentence when there were none, or none answered. */
export function waitWords(asks, which) {
    if (!asks) return NOT_RECORDED;
    if (!asks.asked) return 'No asks';
    if (!asks.answered || asks[which] == null) return 'No answer yet';
    return fmtWait(asks[which]);
}
/** n per task: not recorded when either figure is missing, a sentence when no task was done. */
export const perTaskWords = (n, tasks) => (n == null || tasks == null ? NOT_RECORDED : tasks > 0 ? (n / tasks).toFixed(1) : 'No tasks done');
export function fmtWait(s) {
    if (!Number.isFinite(s)) return '—';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** What an activity read becomes for the Operator tab. A figure the read does not carry (the touches the new recording will add) is null, and the page says "not recorded yet". */
export function operatorModel(activity) {
    const a = activity || {}, touches = a.touches || null;
    const days = (a.days || []).map(d => ({ day: d.day, label: dayLabel(d.day), tasks: d.tasks_done || 0, values: { posts: d.operator || 0, ...(touches ? touchDay(touches, d.day) : {}) } }));
    const posts = Array.isArray(a.days) ? days.reduce((n, d) => n + d.values.posts, 0) : null; // a read with no days has not recorded the posts
    const kinds = [{ key: 'posts', name: 'Board posts by the Operator', recorded: true }, ...(touches ? ['typed', 'answer', 'approve', 'wake', 'restart', 'stop'].map(k => ({ key: k, name: KIND_NAMES[k], recorded: true })) : [])];
    const sumTouches = days.reduce((n, d) => n + Object.values(d.values).reduce((x, v) => x + v, 0), 0);
    const agents = (a.agents || []).map(g => ({ name: g.name, toOperator: g.to_operator || 0, asks: g.asks_operator || 0, ...(touches ? touchAgent(touches, g.name) : {}) }))
        .map(g => ({ ...g, need: g.toOperator + g.asks + (g.touches || 0) })).filter(g => g.need > 0).sort((x, y) => y.need - x.need || x.name.localeCompare(y.name));
    const done = a.tasks_done == null ? null : Number(a.tasks_done) || 0;
    const typed = touches ? days.reduce((n, d) => n + (d.values.typed || 0), 0) : null; // the Operator's typing into agents (chat box or terminal), one per burst; null: not recorded
    return { days, kinds, posts, typed, touches: sumTouches, tasksDone: done, perTask: done > 0 ? sumTouches / done : null, asks: a.operator_asks || null, agents, recorded: !!touches, hub: touches && touches.sources ? Number(touches.sources.hub) || 0 : 0, truncated: !!a.truncated };
}
const KIND_NAMES = { typed: 'Typed to an agent', answer: 'Answers to a question or prompt', approve: 'Approvals', wake: 'Wakes', restart: 'Restarts', stop: 'Stops' };
function touchDay(t, day) { const d = (t.days || []).find(x => x.day === day) || {}; const o = {}; for (const k of Object.keys(KIND_NAMES)) o[k] = Number(d[k]) || 0; return o; }
function touchAgent(t, name) { const g = (t.agents || []).find(x => x.name === name) || {}; return { touches: Object.keys(KIND_NAMES).reduce((n, k) => n + (Number(g[k]) || 0), 0) }; }

/** What an activity read becomes for the Team communication tab: the matrix of who @mentioned whom (agents with any traffic, busiest first, at most `limit`), the days by kind, and the per-agent table. */
export function commModel(activity, { limit = 10 } = {}) {
    const a = activity || {}, edges = a.edges || [];
    const traffic = new Map();
    for (const g of a.agents || []) traffic.set(g.name, (g.sent || 0) + (g.received || 0));
    for (const e of edges) { traffic.set(e.from, traffic.get(e.from) || 0); traffic.set(e.to, traffic.get(e.to) || 0); }
    const names = [...traffic.entries()].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, limit).map(([n]) => n);
    const idx = new Map(names.map((n, i) => [n, i]));
    const cells = names.map(() => names.map(() => 0));
    for (const e of edges) if (idx.has(e.from) && idx.has(e.to)) cells[idx.get(e.from)][idx.get(e.to)] += e.count;
    const days = (a.days || []).map(d => ({ day: d.day, label: dayLabel(d.day), values: { posts: d.posts || 0, cross: d.cross || 0, automated: d.automated || 0 } }));
    const agents = (a.agents || []).map(g => ({ name: g.name, sent: g.sent || 0, received: g.received || 0 })).sort((x, y) => y.sent - x.sent || x.name.localeCompare(y.name));
    const tasks = Array.isArray(a.task_messages) ? a.task_messages : null; // the per-task counts the recording will add: null is "not recorded yet"
    const pairs = Array.isArray(a.pairs) ? pairGrid(a.pairs) : null; // null: the read did not send them (not recorded yet)
    const done = a.tasks_done == null ? null : Number(a.tasks_done) || 0, msgs = a.agent_posts == null ? null : Number(a.agent_posts) || 0;
    return { names, cells, days, agents, tasks, pairs, kpis: { agent: msgs, automated: a.automated_posts == null ? null : a.automated_posts, cross: a.cross_posts == null ? null : a.cross_posts, assigned: a.assigned == null ? null : a.assigned, asks: a.asks || null, busiest: edges[0] || null, tasksDone: done }, truncated: !!a.truncated, empty: !msgs && !(a.cross_posts || 0) && a.agent_posts != null };
}

/** The autonomy trend: touches per task done over a rolling 7 days, one point a day from the 7th (a window with no task done has no point: it is not a 0). `days` are operatorModel's. */
export function autonomyTrend(days) {
    const points = [];
    for (let i = 6; i < days.length; i++) {
        const win = days.slice(i - 6, i + 1), tasks = win.reduce((n, d) => n + (d.tasks || 0), 0);
        const touches = win.reduce((n, d) => n + Object.values(d.values).reduce((x, v) => x + v, 0), 0);
        points.push({ label: days[i].label, value: tasks > 0 ? touches / tasks : null, touches, tasks });
    }
    const done = points.filter(p => p.value != null);
    return { points, first: done[0] || null, last: done.at(-1) || null, enough: done.length >= 2 };
}

/** The team-to-team traffic of an activity read's `pairs` ([{from, to, messages, requests, accepted}]): the teams (busiest first), a grid of messages plus goal requests (rows ask, columns are asked), and the rows as they are. */
export function pairGrid(rawPairs) {
    const team = (n, srv) => (srv ? `${n} on ${srv}` : n); // two teams of one name on two servers are two teams
    const pairs = rawPairs.map(p => ({ ...p, from: team(p.from, p.from_server), to: team(p.to, p.to_server) }));
    const traffic = new Map();
    for (const p of pairs) { const n = (p.messages || 0) + (p.requests || 0); traffic.set(p.from, (traffic.get(p.from) || 0) + n); traffic.set(p.to, (traffic.get(p.to) || 0) + n); }
    const names = [...traffic.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([n]) => n);
    const idx = new Map(names.map((n, i) => [n, i])), cells = names.map(() => names.map(() => 0));
    for (const p of pairs) cells[idx.get(p.from)][idx.get(p.to)] += (p.messages || 0) + (p.requests || 0);
    const rows = pairs.map(p => ({ from: p.from, to: p.to, messages: p.messages || 0, requests: p.requests || 0, accepted: p.accepted || 0 })).sort((x, y) => (y.messages + y.requests) - (x.messages + x.requests) || (x.from + x.to).localeCompare(y.from + y.to));
    return { names, cells, rows, total: rows.reduce((n, r) => n + r.messages + r.requests, 0) };
}
