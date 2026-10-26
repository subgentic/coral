/* The Analytics breakdown views over time (#7857, the operator's mock): above By provider, By model, By team and By agent a line chart with one line per row of the table, for the metric picked (Cost,
 * Input, Output, Cache read, Cache write, Requests), as a running total or for each interval of the range. The table is the legend (a swatch before the first column's name; a click on a row
 * brings its line forward), the lines are the top 7 by cost and the rest as Other, and the chart is aria-hidden: the table beside it is its text alternative. Under the table a line says whether the
 * rows add up to where the chart ends. It reads GET /api/token-usage/timeseries?group_by=team|agent|provider|model (each bucket lists its series). Everything is built with the DOM and textContent:
 * names are written by agents. */
import { compactCount, formatCost } from './format.js';

export const METRICS = [
    { key: 'cost_usd', label: 'Cost', fmt: v => formatCost(v, { zeroAsTwo: true }), table: 'cost_usd' },
    { key: 'input_tokens', label: 'Input', fmt: compactCount, table: 'input_tokens' },
    { key: 'output_tokens', label: 'Output', fmt: compactCount, table: 'output_tokens' },
    { key: 'cache_read_tokens', label: 'Cache read', fmt: compactCount, table: 'cache_read_tokens' },
    { key: 'cache_write_tokens', label: 'Cache write', fmt: compactCount, table: 'cache_write_tokens' },
    { key: 'num_requests', label: 'Requests', fmt: compactCount, table: 'requests' },
];
export const GROUPS = { provider: 'provider', model: 'model', team: 'team', agent: 'agent' };
export const TOP = 7;
const STEP_MS = { '5m': 300000, '1h': 3600000, '1d': 86400000 };
const STEP_WORD = { '5m': 'each 5 minutes', '1h': 'each hour', '1d': 'each day' };

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (tag, attrs, text) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };

// ── pure: the axis and the series ───────────────────────────────────────

/** The start of the bucket a time falls in, as the server writes it (UTC, on the interval's grid). */
export function bucketStart(ms, interval) { const s = STEP_MS[interval] || STEP_MS['1h']; return Math.floor(ms / s) * s; }

/** The bucket times from `from` to `to` (both inclusive), every step: a time with no usage is a zero, not a gap. At most 2000 points. */
export function axis(fromMs, toMs, interval) {
    const s = STEP_MS[interval] || STEP_MS['1h'], out = [];
    for (let t = bucketStart(fromMs, interval); t <= toMs && out.length < 2000; t += s) out.push(t);
    return out;
}

/** The keys in the order of what they cost over the buckets (their request count when nothing cost), the dearest first: the one order the colours follow, whichever metric is shown. */
export function rankKeys(buckets) {
    const cost = new Map(), reqs = new Map();
    for (const b of buckets) for (const s of b.series || []) { cost.set(s.key, (cost.get(s.key) || 0) + (s.cost_usd || 0)); reqs.set(s.key, (reqs.get(s.key) || 0) + (s.num_requests || 0)); }
    return [...cost.keys()].sort((a, b) => (cost.get(b) - cost.get(a)) || (reqs.get(b) - reqs.get(a)) || String(a).localeCompare(String(b)));
}

/** The series of a metric: the top `top` keys of `ranked` each their own line, every other key one "Other" line; every line has a value for every time of the axis; `cumulative` makes each a running total. */
export function buildSeries(buckets, ranked, times, metric, cumulative, top = TOP) {
    const at = new Map(times.map((t, i) => [t, i]));
    const keep = new Set(ranked.slice(0, top));
    const lines = ranked.slice(0, top).map(k => ({ key: k, label: k, other: false, vals: new Array(times.length).fill(0) }));
    const byKey = new Map(lines.map(l => [l.key, l]));
    const rest = { key: OTHER, label: `Other (${Math.max(0, ranked.length - top)})`, other: true, vals: new Array(times.length).fill(0) };
    for (const b of buckets) {
        const i = at.get(Date.parse(b.bucket));
        if (i == null) continue;
        for (const s of b.series || []) (keep.has(s.key) ? byKey.get(s.key) : rest).vals[i] += Number(s[metric]) || 0;
    }
    if (ranked.length > top) lines.push(rest);
    for (const l of lines) {
        l.total = l.vals.reduce((a, b) => a + b, 0);
        if (cumulative) { let run = 0; l.plot = l.vals.map(v => (run += v)); } else l.plot = l.vals;
    }
    return lines;
}

/** Whether a table's rows add up to the chart's total, within what a float can say. */
export function agrees(a, b) { return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)); }

// ── the chart ───────────────────────────────────────────────────────────

const niceMax = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const colorOf = (line, i) => (line.other ? 'var(--viz-other)' : `var(--viz-${(i % 7) + 1})`);
export const lineColor = (view, key, ranked) => { const i = ranked.indexOf(key); return i < 0 || i >= TOP ? 'var(--viz-other)' : `var(--viz-${i + 1})`; };

function timeLabel(ms, interval) {
    const d = new Date(ms);
    if (interval === '1d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (interval === '5m') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
}

/** The lines as one SVG (aria-hidden: the table is the text alternative), with a crosshair and a tooltip that names every line at the time, the end labels of the top two and a dash pattern per line for forced colours. */
export function drawChart(host, { times, lines, metric, interval, hi, phone }) {
    host.replaceChildren();
    const W = Math.max(280, Math.round(host.clientWidth || (phone ? 340 : 880))), H = phone ? 200 : 250, L = 48, R = phone ? 12 : 104, T = 10, B = 24, pw = W - L - R, ph = H - T - B, N = times.length;
    const m = METRICS.find(x => x.key === metric) || METRICS[0];
    const max = niceMax(Math.max(0, ...lines.flatMap(l => l.plot)));
    const x = i => L + (N > 1 ? (i / (N - 1)) * pw : pw / 2), y = v => T + ph - (v / max) * ph;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false', class: 'viz-svg' });
    for (let g = 0; g <= 4; g++) { const v = (max / 4) * g; s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'viz-grid' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, m.fmt(v))); }
    const ticks = N <= 1 ? [0] : [0, Math.round((N - 1) / 3), Math.round(((N - 1) * 2) / 3), N - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of ticks.slice(0, phone ? 3 : 4)) s.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === N - 1 ? 'end' : 'middle', class: 'viz-axis' }, timeLabel(times[i], interval)));
    const order = lines.map((l, k) => k).sort((a, b) => (hi === lines[a].key) - (hi === lines[b].key)); // the highlighted line is drawn last, so in front
    for (const k of order) {
        const l = lines[k], dim = hi && hi !== l.key;
        s.append(svg('path', { d: l.plot.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '), class: `viz-line viz-line-${l.other ? 'o' : k % 7}`, stroke: colorOf(l, k), 'stroke-width': hi === l.key ? 3.5 : 2, fill: 'none', opacity: dim ? 0.2 : 1 }));
    }
    if (!phone) { // the end labels: the top two by where they end
        let lastY = -99;
        for (const l of lines.map(l => l).sort((a, b) => (b.plot[N - 1] || 0) - (a.plot[N - 1] || 0)).slice(0, 2)) {
            const yy = Math.max(y(l.plot[N - 1] || 0) + 4, lastY + 14); lastY = yy;
            if (!(hi && hi !== l.key)) s.append(svg('text', { x: W - R + 6, y: yy, class: 'viz-end' }, l.label.length > 15 ? `${l.label.slice(0, 14)}…` : l.label));
        }
    }
    const cross = svg('line', { y1: T, y2: T + ph, class: 'viz-cross', visibility: 'hidden' }); s.append(cross);
    const dots = lines.map((l, k) => { const c = svg('circle', { r: 4, fill: colorOf(l, k), class: 'viz-dot', visibility: 'hidden' }); s.append(c); return c; });
    const hit = svg('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }); s.append(hit);
    host.classList.add('viz-host'); host.append(s);
    const tip = el('div', 'viz-tip'); tip.hidden = true; host.append(tip);
    const show = ev => {
        const r = s.getBoundingClientRect(), sx = r.width / W, px = (ev.clientX - r.left) / sx;
        const i = Math.max(0, Math.min(N - 1, Math.round(N > 1 ? ((px - L) / pw) * (N - 1) : 0)));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        dots.forEach((c, k) => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(lines[k].plot[i])); c.setAttribute('visibility', 'visible'); });
        tip.replaceChildren(el('div', 'viz-tip-when', timeLabel(times[i], interval)));
        const rows = lines.map((l, k) => ({ l, k, v: l.plot[i] })).sort((a, b) => b.v - a.v).slice(0, 6);
        for (const e of rows) { const row = el('div', 'viz-tip-row'); const key = el('i'); key.style.background = colorOf(e.l, e.k); const name = el('span'); name.append(key, document.createTextNode(e.l.label)); row.append(name, el('b', null, m.fmt(e.v))); tip.append(row); }
        if (lines.length > 6) tip.append(el('div', 'viz-tip-when', `+${lines.length - 6} more in the table`));
        tip.hidden = false;
        const hr = host.getBoundingClientRect(); let tx = ev.clientX - hr.left + 14; if (tx + 200 > hr.width) tx = ev.clientX - hr.left - 214; tip.style.left = `${Math.max(4, tx)}px`; tip.style.top = '8px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(c => c.setAttribute('visibility', 'hidden')); });
}

// ── the panel above a table ─────────────────────────────────────────────

export const OTHER = '\u0000other';
const state = {}; // per view: metric, cumulative, hi, data ({ buckets, interval, since, until }), ranked

export const seriesState = view => (state[view] ||= { metric: 'cost_usd', cumulative: true, hi: '', data: null, ranked: [], error: '' });
/** The line colour of a table row's key (a swatch), or '' when it has no line. */
export const swatchColor = (view, key) => { const st = state[view]; return st && st.data ? lineColor(view, key, st.ranked) : ''; };
/** The key of the line a table row belongs to: its own, or Other when the row is not among the top 7. */
export const lineKeyOf = (view, key) => { const st = state[view]; return st && st.ranked.indexOf(key) >= TOP ? OTHER : key; };
export const highlighted = view => (state[view] ? state[view].hi : '');
export function setHighlight(view, key, redraw) { const st = seriesState(view); st.hi = st.hi === key ? '' : key; if (redraw) redraw(); }
export const wordFor = interval => STEP_WORD[interval] || STEP_WORD['1h'];

/** Sets what the view has read (null while it loads or after an error) and keeps the colours' order. */
export function setData(view, data, error) { const st = seriesState(view); st.data = data; st.error = error || ''; st.ranked = data ? rankKeys(data.buckets) : []; }

function seg(label, items, cur, on) {
    const wrap = el('div', 'viz-ctl'); wrap.append(el('span', 'viz-ctl-label', label));
    const g = el('div', 'viz-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    for (const [k, t] of items) { const b = el('button', null, t); b.type = 'button'; b.setAttribute('aria-pressed', String(k === cur)); b.addEventListener('click', () => on(k)); g.append(b); }
    wrap.append(g); return wrap;
}

/** Draws the panel: the pickers, the chart and the line under the table ("Totals agree"). tableTotal(metricTableField) is the sum of the table's rows for that figure, or null when the table has none;
 *  redraw re-draws the table beside it (its swatches), and again(view) draws this panel again. */
export function drawPanel(host, view, { tableTotal, redraw, phone }) {
    host.replaceChildren();
    const st = seriesState(view);
    if (st.error) { const e = el('p', 'cost-empty', st.error); e.setAttribute('role', 'status'); host.append(e); return; }
    if (!st.data) { host.append(el('p', 'cost-empty', 'Loading the chart…')); return; }
    const { buckets, interval, sinceMs, untilMs } = st.data;
    const times = axis(sinceMs, untilMs, interval);
    if (!buckets.length || !st.ranked.length) { host.append(el('p', 'cost-empty', 'No usage over time in this range yet.')); return; }
    const m = METRICS.find(x => x.key === st.metric) || METRICS[0];
    const again = () => { drawPanel(host, view, { tableTotal, redraw, phone }); redraw?.(); };
    const tools = el('div', 'viz-tools');
    tools.append(seg('Metric', METRICS.map(x => [x.key, x.label]), st.metric, k => { st.metric = k; again(); }),
        seg('Show', [['cum', 'Running total'], ['int', wordFor(interval).replace(/^each/, 'Each')]], st.cumulative ? 'cum' : 'int', k => { st.cumulative = k === 'cum'; again(); }));
    const lines = buildSeries(buckets, st.ranked, times, m.key, st.cumulative);
    const card = el('div', 'viz-card');
    card.append(el('h4', 'viz-title', `${m.label}, ${st.cumulative ? 'running total' : wordFor(interval)}`));
    const chart = el('div', 'viz-chart'); card.append(chart);
    host.append(tools, card);
    drawChart(chart, { times, lines, metric: m.key, interval, hi: st.hi, phone });
    // the rows against the chart: one figure, said once, or the two that differ
    const rowsTotal = tableTotal ? tableTotal(m.table) : null, chartTotal = lines.reduce((a, l) => a + l.total, 0);
    if (rowsTotal != null) {
        const ok = agrees(rowsTotal, chartTotal), line = el('p', `viz-check${ok ? '' : ' viz-check-bad'}`);
        line.setAttribute('role', 'status');
        if (ok) line.append(el('b', null, '✓ Totals agree'), document.createTextNode(` The table's rows add up to ${m.fmt(rowsTotal)}, where the chart ends.`));
        else line.append(el('b', null, '✗ Totals differ'), document.createTextNode(` The table's rows add up to ${m.fmt(rowsTotal)}, the chart to ${m.fmt(chartTotal)}.`));
        host.append(line);
    }
}
