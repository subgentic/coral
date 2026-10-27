/* The Analytics breakdown views over time (#7857, the operator's mock): above By provider, By model, By team and By agent a line chart with one line per row of the table, for the metric picked (Cost,
 * Input, Output, Cache read, Cache write, Requests), as a running total or for each interval of the range. The table is the legend (a swatch before the first column's name; a click on a row
 * brings its line forward), the lines are the top 7 by cost and the rest as Other, and the chart is aria-hidden: the table beside it is its text alternative. Under the table a line says whether the
 * rows add up to where the chart ends. It reads GET /api/token-usage/timeseries?group_by=team|agent|provider|model (each bucket lists its series). Everything is built with the DOM and textContent:
 * names are written by agents. */
import { compactCount, formatCost } from './format.js';
import { watchScrollCue } from './scroll_cue.js';

export const METRICS = [
    { key: 'cost_usd', label: 'Cost', fmt: v => formatCost(v, { zeroAsTwo: true }), table: 'cost_usd' },
    { key: 'input_tokens', label: 'Input', fmt: compactCount, table: 'input_tokens' },
    { key: 'output_tokens', label: 'Output', fmt: compactCount, table: 'output_tokens' },
    { key: 'cache_read_tokens', label: 'Cache read', fmt: compactCount, table: 'cache_read_tokens' },
    { key: 'cache_write_tokens', label: 'Cache write', fmt: compactCount, table: 'cache_write_tokens' },
    { key: 'num_requests', label: 'Requests', fmt: compactCount, table: 'requests' },
];
export const METRIC_SLOT = { input_tokens: 0, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 3, cost_usd: 0, num_requests: 0 }; // a metric's own colour when metrics are the lines
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

/** Which keys get a line and which colour. With nothing checked: the top `top` of `ranked` (by cost), their colours their ranks, the rest folded into Other. With rows checked: only those, a checked key that was in the top keeping the colour
 *  it had, and a checked key that was not taking a colour no checked key has (so a filter never repaints a line that survives it); more checked keys than colours fold into Other. */
export function assignLines(ranked, selected, top = TOP) {
    const chosen = selected && selected.size ? ranked.filter(k => selected.has(k)) : null;
    if (!chosen) return { active: false, lines: ranked.slice(0, top).map((key, slot) => ({ key, slot })), folded: ranked.slice(top) };
    const used = new Set(), lines = [], later = [];
    for (const k of chosen) { const rank = ranked.indexOf(k); if (rank < top) { lines.push({ key: k, slot: rank }); used.add(rank); } else later.push(k); }
    const folded = [];
    for (const k of later) { let slot = 0; while (slot < top && used.has(slot)) slot++; if (slot < top) { lines.push({ key: k, slot }); used.add(slot); } else folded.push(k); }
    lines.sort((a, b) => ranked.indexOf(a.key) - ranked.indexOf(b.key));
    return { active: true, lines, folded };
}

const finish = l => { l.total = l.vals.reduce((a, b) => a + b, 0); return l; };
const accumulate = (l, cumulative) => { if (cumulative) { let run = 0; l.plot = l.vals.map(v => (run += v)); } else l.plot = l.vals; return l; };

/** The lines of one metric for an assignment: a line per assigned key (every time of the axis has a value), one "Other" line for the folded keys; `cumulative` makes each a running total. */
export function buildSeries(buckets, assignment, times, metric, cumulative) {
    const at = new Map(times.map((t, i) => [t, i]));
    const lines = assignment.lines.map(a => ({ key: a.key, label: a.key, slot: a.slot, other: false, vals: new Array(times.length).fill(0) }));
    const byKey = new Map(lines.map(l => [l.key, l]));
    const folded = new Set(assignment.folded);
    const rest = { key: OTHER, label: `Other (${assignment.folded.length})`, slot: 0, other: true, vals: new Array(times.length).fill(0) };
    for (const b of buckets) {
        const i = at.get(Date.parse(b.bucket));
        if (i == null) continue;
        for (const s of b.series || []) { const to = byKey.get(s.key) || (folded.has(s.key) ? rest : null); if (to) to.vals[i] += Number(s[metric]) || 0; }
    }
    if (assignment.folded.length) lines.push(rest);
    return lines.map(l => accumulate(finish(l), cumulative));
}

/** One key's (or, for the keys folded into Other, their) several metrics as lines: a line per metric, in the metric's own colour. Used when one row is checked and several metrics are picked. */
export function buildMetricLines(buckets, keys, times, metrics, cumulative) {
    const at = new Map(times.map((t, i) => [t, i])), want = new Set(keys);
    const lines = metrics.map(m => ({ key: m.key, label: m.label, slot: METRIC_SLOT[m.key] ?? 0, other: false, vals: new Array(times.length).fill(0) }));
    for (const b of buckets) {
        const i = at.get(Date.parse(b.bucket));
        if (i == null) continue;
        for (const s of b.series || []) if (want.has(s.key)) metrics.forEach((m, k) => { lines[k].vals[i] += Number(s[m.key]) || 0; });
    }
    return lines.map(l => accumulate(finish(l), cumulative));
}

/** The groups of metrics that share a unit, so share one axis: tokens, dollars, requests. */
export function metricUnits(metrics) {
    const unit = m => (m.key === 'cost_usd' ? 'cost' : m.key === 'num_requests' ? 'requests' : 'tokens');
    const out = new Map();
    for (const m of metrics) { const u = unit(m); out.set(u, [...(out.get(u) || []), m]); }
    return [...out.values()];
}

/** Whether a table's rows add up to the chart's total, within what a float can say. */
export function agrees(a, b) { return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)); }

// ── the chart ───────────────────────────────────────────────────────────

/** An axis label: money from $100 up drops the cents (the axis steps are round numbers), so a label never outgrows the margin. */
const axisLabel = (fmt, v) => { const t = fmt(v); return t.startsWith('$') && v >= 100 ? (v >= 1000 ? `$${compactCount(v)}` : `$${Math.round(v)}`) : t; };
const niceMax = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const colorOf = line => (line.other ? 'var(--viz-other)' : `var(--viz-${((line.slot ?? 0) % 7) + 1})`);

export function timeLabel(ms, interval) {
    const d = new Date(ms);
    if (interval === '1d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (interval === '5m') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
}

/** The lines as one SVG (aria-hidden: the table is the text alternative), with a crosshair and a tooltip that names every line at the time, the end labels of the top two and a dash pattern per line for forced colours. */
export function drawChart(host, { times, lines, metric, interval, hi, phone, xLabel, when, fmt, log }) {
    const label = xLabel || (i => timeLabel(times[i], interval)), heading = when || label;
    host.replaceChildren();
    const W = Math.max(280, Math.round(host.clientWidth || (phone ? 340 : 880))), H = phone ? 200 : 250, L = 52, R = phone ? 12 : 112, T = 10, B = 24, pw = W - L - R, ph = H - T - B, N = times.length;
    const m = { ...(METRICS.find(x => x.key === metric) || METRICS[0]), ...(fmt ? { fmt } : {}) };
    const top = Math.max(0, ...lines.flatMap(l => l.plot)), max = log ? 10 ** Math.max(1, Math.ceil(Math.log10(top + 1))) : niceMax(top);
    const x = i => L + (N > 1 ? (i / (N - 1)) * pw : pw / 2), y = log ? (v => T + ph - (Math.log10(1 + Math.max(v, 0)) / Math.log10(1 + max)) * ph) : (v => T + ph - (v / max) * ph);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false', class: 'viz-svg', 'data-scale': log ? 'log' : 'linear' });
    const gridAt = log ? [0, ...Array.from({ length: Math.round(Math.log10(max)) }, (_, k) => 10 ** (k + 1))].filter(v => v <= max) : [0, 1, 2, 3, 4].map(g => (max / 4) * g); // a log axis steps by powers of ten
    for (const v of gridAt) { s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'viz-grid' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, axisLabel(m.fmt, v))); }
    const ticks = N <= 1 ? [0] : [0, Math.round((N - 1) / 3), Math.round(((N - 1) * 2) / 3), N - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of ticks.slice(0, phone ? 3 : 4)) s.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === N - 1 ? 'end' : 'middle', class: 'viz-axis' }, label(i)));
    const order = lines.map((l, k) => k).sort((a, b) => (hi === lines[a].key) - (hi === lines[b].key)); // the highlighted line is drawn last, so in front
    for (const k of order) {
        const l = lines[k], dim = hi && hi !== l.key;
        s.append(svg('path', { d: l.plot.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '), class: `viz-line viz-line-${l.other ? 'o' : (l.slot ?? 0) % 7}`, stroke: colorOf(l), 'stroke-width': hi === l.key ? 3.5 : 2, fill: 'none', opacity: dim ? 0.2 : 1 }));
    }
    if (!phone) { // the end labels: the top two by where they end
        let lastY = -99;
        for (const l of lines.map(l => l).sort((a, b) => (b.plot[N - 1] || 0) - (a.plot[N - 1] || 0)).slice(0, 2)) {
            const yy = Math.max(y(l.plot[N - 1] || 0) + 4, lastY + 16); lastY = yy;
            if (!(hi && hi !== l.key)) s.append(svg('text', { x: W - R + 6, y: yy, class: 'viz-end' }, l.label.length > 15 ? `${l.label.slice(0, 14)}…` : l.label));
        }
    }
    const cross = svg('line', { y1: T, y2: T + ph, class: 'viz-cross', visibility: 'hidden' }); s.append(cross);
    const dots = lines.map((l, k) => { const c = svg('circle', { r: 4, fill: colorOf(l), class: 'viz-dot', visibility: 'hidden' }); s.append(c); return c; });
    const hit = svg('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }); s.append(hit);
    host.classList.add('viz-host'); host.append(s);
    const tip = el('div', 'viz-tip'); tip.hidden = true; host.append(tip);
    const show = ev => {
        const r = s.getBoundingClientRect(), sx = r.width / W, px = (ev.clientX - r.left) / sx;
        const i = Math.max(0, Math.min(N - 1, Math.round(N > 1 ? ((px - L) / pw) * (N - 1) : 0)));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        dots.forEach((c, k) => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(lines[k].plot[i])); c.setAttribute('visibility', 'visible'); });
        tip.replaceChildren(el('div', 'viz-tip-when', heading(i)));
        const rows = lines.map((l, k) => ({ l, k, v: l.plot[i] })).sort((a, b) => b.v - a.v).slice(0, 6);
        for (const e of rows) { const row = el('div', 'viz-tip-row'); const key = el('i'); key.style.background = colorOf(e.l); const name = el('span'); name.append(key, document.createTextNode(e.l.label)); row.append(name, el('b', null, m.fmt(e.v))); tip.append(row); }
        if (lines.length > 6) tip.append(el('div', 'viz-tip-when', `+${lines.length - 6} more in the table`));
        tip.hidden = false;
        const hr = host.getBoundingClientRect(); let tx = ev.clientX - hr.left + 14; if (tx + 200 > hr.width) tx = ev.clientX - hr.left - 214; tip.style.left = `${Math.max(4, tx)}px`; tip.style.top = '8px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(c => c.setAttribute('visibility', 'hidden')); });
}

// ── the panel above a table ─────────────────────────────────────────────

export const OTHER = '\u0000other';
const state = {}; // per view: metrics, cumulative, hi, selected, data ({ buckets, interval, sinceMs, untilMs }), ranked

const seriesState = view => (state[view] ||= { metrics: ['cost_usd'], cumulative: true, hi: '', selected: new Set(), data: null, ranked: [], error: '' });
/** The line colour of a table row's key (a swatch): its line's, Other's when it is folded into it, 'off' when rows are checked and this one is not, '' when nothing is read yet. */
export function swatchColor(view, key) {
    const st = state[view]; if (!st || !st.data) return '';
    const a = assignLines(st.ranked, st.selected), hit = a.lines.find(l => l.key === key);
    if (hit) return `var(--viz-${hit.slot + 1})`;
    if (a.folded.includes(key)) return 'var(--viz-other)';
    return a.active ? 'off' : 'var(--viz-other)';
}
/** The key of the line a table row belongs to: its own, or Other when it is folded into it. */
export const lineKeyOf = (view, key) => { const st = state[view]; return st && assignLines(st.ranked, st.selected).folded.includes(key) ? OTHER : key; };
export const highlighted = view => (state[view] ? state[view].hi : '');
export function setHighlight(view, key, redraw) { const st = seriesState(view); st.hi = st.hi === key ? '' : key; if (redraw) redraw(); }
export const wordFor = interval => STEP_WORD[interval] || STEP_WORD['1h'];
/** Whether a row has a line of its own now (not folded into Other, not left out). */
export const hasLine = (view, key) => { const st = state[view]; return !!st && st.data != null && assignLines(st.ranked, st.selected).lines.some(l => l.key === key); };
/** A row's swatch is the switch of its line. In the default view (the top 7 and Other) a row with a line is left out, and a row in Other is shown alone; once rows are chosen each swatch adds or removes its row, and the last
 *  one removed brings the default back. */
export function toggleLine(view, key) {
    const st = seriesState(view), asg = assignLines(st.ranked, st.selected);
    let next;
    if (!st.selected.size) next = asg.lines.some(l => l.key === key) ? new Set(asg.lines.map(l => l.key).filter(k => k !== key)) : new Set([key]);
    else { next = new Set(st.selected); if (next.has(key)) next.delete(key); else next.add(key); }
    const def = asg.active ? assignLines(st.ranked, null).lines.map(l => l.key) : asg.lines.map(l => l.key);
    if (next.size === def.length && def.every(k => next.has(k))) next = new Set(); // the top 7 chosen again is the default (and brings Other back)
    st.selected = next;
    if (st.hi && st.hi !== OTHER && st.selected.size && !st.selected.has(st.hi)) st.hi = '';
}
/** Back to the top 7 and Other. */
function resetLines(view) { seriesState(view).selected = new Set(); }
/** Sets what the view has read (null while it loads or after an error) and keeps the colours' order. */
export function setData(view, data, error) { const st = seriesState(view); st.data = data; st.error = error || ''; st.ranked = data ? rankKeys(data.buckets) : []; }

function seg(label, items, isOn, onToggle, multi) {
    const wrap = el('div', 'viz-ctl'); wrap.append(el('span', 'viz-ctl-label', label));
    const g = el('div', multi ? 'viz-seg btn-seg viz-multi' : 'viz-seg btn-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    for (const [k, t] of items) { const b = el('button', 'btn', t); b.type = 'button'; b.setAttribute('aria-pressed', String(isOn(k))); b.addEventListener('click', () => onToggle(k)); g.append(b); }
    wrap.append(g); watchScrollCue(g); return wrap;
}
const joinWords = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** The bold start of the "Totals" line: its mark is drawn, not read ("check mark Totals agree"); the words say it. */
function markedLine(mark, words) { const b = el('b'), m = el('span', null, mark); m.setAttribute('aria-hidden', 'true'); b.append(m, document.createTextNode(` ${words}`)); return b; }

/** Draws the panel: the pickers (the metrics, any of them together; running total or each interval), the chart or charts, and the line under them ("Totals agree"). With one metric: a line per shown row.
 *  With several metrics and one row: a line per metric (one chart per unit: tokens together, dollars and requests apart). With several metrics and several rows: one chart per metric, a line per row, one under another.
 *  tableTotal(field, keys) is the sum of the table's rows (those with these keys, or all when keys is null) for a table figure, or null when the table has none; redraw draws the table beside it again. */
export function drawPanel(host, view, { tableTotal, redraw, phone }) {
    host.replaceChildren();
    const st = seriesState(view);
    if (st.error) { const e = el('p', 'empty-state', st.error); e.setAttribute('role', 'status'); host.append(e); return; }
    if (!st.data) { host.append(el('p', 'empty-state', 'Loading the chart…')); return; }
    const { buckets, interval, sinceMs, untilMs } = st.data;
    const times = axis(sinceMs, untilMs, interval);
    if (!buckets.length || !st.ranked.length) { host.append(el('p', 'empty-state', 'No usage over time in this range yet.')); return; }
    const again = () => { drawPanel(host, view, { tableTotal, redraw, phone }); redraw?.(); };
    const picked = METRICS.filter(x => st.metrics.includes(x.key));
    const tools = el('div', 'viz-tools');
    tools.append(seg('Metrics', METRICS.map(x => [x.key, x.label]), k => st.metrics.includes(k), k => { st.metrics = st.metrics.includes(k) ? (st.metrics.length > 1 ? st.metrics.filter(x => x !== k) : st.metrics) : [...st.metrics, k]; again(); }, true),
        seg('Show', [['cum', 'Running total'], ['int', wordFor(interval).replace(/^each/, 'Each')]], k => (k === 'cum') === st.cumulative, k => { st.cumulative = k === 'cum'; again(); }));
    const asg = assignLines(st.ranked, st.selected), when = st.cumulative ? 'running total' : wordFor(interval);
    const oneRowMany = picked.length > 1 && asg.lines.length === 1 && !asg.folded.length;
    if (oneRowMany) tools.append(seg('Scale', [['lin', 'Linear'], ['log', 'Log']], k => (k === 'log') === !!st.log, k => { st.log = k === 'log'; again(); })); // the metrics of one row differ by orders of magnitude: a log axis reads them together
    host.append(tools);
    const shownKeys = [...asg.lines.map(l => l.key), ...asg.folded];
    const rowsOf = st.selected.size ? shownKeys : null;
    const card = (title, hint) => { const c = el('div', 'viz-card'); c.append(el('h4', 'viz-title', title)); if (hint) c.append(el('p', 'viz-hint', hint)); const chart = el('div', 'viz-chart'); c.append(chart); host.append(c); return chart; };
    const checks = [];
    const addReset = (after, n) => { const p = el('p', 'viz-hint'); p.append(document.createTextNode(`Showing ${n} of ${st.ranked.length} rows. `)); const b = el('button', 'viz-linkbtn', `Show the top ${TOP}`); b.type = 'button'; b.addEventListener('click', () => { resetLines(view); again(); }); p.append(b); after.after(p); };
    const byRows = (m, title) => { // a line per shown row, for one metric
        const lines = buildSeries(buckets, asg, times, m.key, st.cumulative), chart = card(title, '');
        if (asg.active) addReset(chart.parentElement.querySelector('.viz-title'), shownKeys.length);
        drawChart(chart, { times, lines, metric: m.key, interval, hi: st.hi, phone });
        checks.push([m, lines.reduce((a, l) => a + l.total, 0)]);
    };
    if (picked.length === 1) byRows(picked[0], `${picked[0].label}, ${when}`);
    else if (asg.lines.length === 1 && !asg.folded.length) { // one row, several metrics: the metrics are the lines, a chart for each unit
        for (const group of metricUnits(picked)) {
            const lines = buildMetricLines(buckets, [asg.lines[0].key], times, group, st.cumulative), chart = card(`${asg.lines[0].key}: ${joinWords(group.map(g => g.label))}, ${when}`);
            if (asg.active) addReset(chart.parentElement.querySelector('.viz-title'), shownKeys.length);
            drawChart(chart, { times, lines, metric: group[0].key, interval, hi: '', phone, log: !!st.log && group.length > 1 });
            if (lines.length > 1) { // the metrics are the lines: a key (the table names rows, not metrics), each metric with what it adds up to
                const ul = el('ul', 'viz-legend viz-legend-plain');
                lines.forEach((l, i) => { const li = el('li', 'viz-legend-item'), sw = el('i', 'cost-swatch'); sw.style.background = colorOf(l); sw.setAttribute('aria-hidden', 'true'); li.append(sw, el('span', 'viz-legend-name', l.label), el('span', 'viz-legend-value', group[i].fmt(l.total))); ul.append(li); });
                chart.parentElement.append(ul);
            }
            lines.forEach((l, i) => checks.push([group[i], l.total]));
        }
    } else for (const m of picked) byRows(m, `${m.label}, ${when}`); // several rows, several metrics: one chart each
    // the rows against the charts: one line saying it once, or the figures that differ
    const rows = checks.map(([m, chartTotal]) => ({ m, chartTotal, rowsTotal: tableTotal ? tableTotal(m.table, rowsOf) : null })).filter(x => x.rowsTotal != null);
    if (rows.length) {
        const bad = rows.filter(x => !agrees(x.rowsTotal, x.chartTotal)), line = el('p', `viz-check${bad.length ? ' viz-check-bad' : ''}`);
        line.setAttribute('role', 'status');
        if (!bad.length) line.append(markedLine('\u2713', 'Totals agree'), document.createTextNode(rows.length === 1 ? ` The table's rows add up to ${rows[0].m.fmt(rows[0].rowsTotal)}, where the chart ends.` : ` The table's rows add up to what each chart ends on (${joinWords(rows.map(x => x.m.label))}).`));
        else line.append(markedLine('\u2717', 'Totals differ'), document.createTextNode(` ${joinWords(bad.map(x => `${x.m.label}: the table's rows ${x.m.fmt(x.rowsTotal)}, the chart ${x.m.fmt(x.chartTotal)}`))}.`));
        host.append(line);
    }
}

// ── the Overview: the change against the period before, and cost by team stacked ─────────────────────

const PRIOR_WORD = { hour: 'the hour before', day: 'the prior 24 hours', week: 'the prior 7 days', month: 'the prior 30 days' };
export const priorWord = period => PRIOR_WORD[period] || PRIOR_WORD.day;

/** What a figure did against the same stretch before it: "+12%" or "\u22123%", never a colour; '' when the stretch before had nothing to compare with (the comparison is said once, in the page's subtitle). */
export function changeText(current, prior) {
    const c = Number(current) || 0, p = Number(prior) || 0;
    if (!p) return '';
    const pct = Math.round(((c - p) / p) * 100);
    return pct === 0 ? '0%' : `${pct > 0 ? '+' : '\u2212'}${Math.abs(pct)}%`;
}

/** The totals of a time series' buckets (what a period before is compared by). */
export function bucketTotals(buckets) {
    const t = { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: 0 };
    for (const b of buckets || []) for (const k in t) t[k] += Number(b[k]) || 0;
    return t;
}

/** The lines stacked, each fill one line (2 px of the surface between fills), the daily or hourly total the height; a crosshair and a tooltip that lists the fills at the time and their total. */
function drawArea(host, { times, lines, metric, interval, hi, phone }) {
    host.replaceChildren();
    const W = Math.max(280, Math.round(host.clientWidth || (phone ? 340 : 880))), H = phone ? 190 : 230, L = 52, R = 12, T = 10, B = 24, pw = W - L - R, ph = H - T - B, N = times.length;
    const m = METRICS.find(x => x.key === metric) || METRICS[0];
    const sums = times.map((_, i) => lines.reduce((a, l) => a + l.vals[i], 0));
    const max = niceMax(Math.max(0, ...sums));
    const x = i => L + (N > 1 ? (i / (N - 1)) * pw : pw / 2), y = v => T + ph - (v / max) * ph;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false', class: 'viz-svg' });
    for (let g = 0; g <= 4; g++) { const v = (max / 4) * g; s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'viz-grid' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, axisLabel(m.fmt, v))); }
    const ticks = N <= 1 ? [0] : [0, Math.round((N - 1) / 3), Math.round(((N - 1) * 2) / 3), N - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of ticks.slice(0, phone ? 3 : 4)) s.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === N - 1 ? 'end' : 'middle', class: 'viz-axis' }, timeLabel(times[i], interval)));
    let base = new Array(N).fill(0);
    lines.forEach((l, k) => { // the first line is the bottom fill
        const top = base.map((b, i) => b + l.vals[i]);
        const d = top.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') + ' ' + base.map((_, i) => `L${x(N - 1 - i).toFixed(1)} ${y(base[N - 1 - i]).toFixed(1)}`).join(' ') + ' Z';
        s.append(svg('path', { d, class: 'viz-fill', fill: colorOf(l), opacity: hi && hi !== l.key ? 0.25 : 1 })); base = top;
    });
    const cross = svg('line', { y1: T, y2: T + ph, class: 'viz-cross', visibility: 'hidden' }); s.append(cross);
    const hit = svg('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' }); s.append(hit);
    host.classList.add('viz-host'); host.append(s);
    const tip = el('div', 'viz-tip'); tip.hidden = true; host.append(tip);
    const show = ev => {
        const r = s.getBoundingClientRect(), sx = r.width / W, i = Math.max(0, Math.min(N - 1, Math.round(N > 1 ? ((((ev.clientX - r.left) / sx) - L) / pw) * (N - 1) : 0)));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        tip.replaceChildren(el('div', 'viz-tip-when', timeLabel(times[i], interval)));
        for (const [l, k] of lines.map((l, k) => [l, k]).reverse().filter(([l]) => l.vals[i] > 0).slice(0, 6)) { const row = el('div', 'viz-tip-row'), key = el('i'); key.style.background = colorOf(l); const name = el('span'); name.append(key, document.createTextNode(l.label)); row.append(name, el('b', null, m.fmt(l.vals[i]))); tip.append(row); }
        const all = el('div', 'viz-tip-row'); all.append(el('span', null, 'All'), el('b', null, m.fmt(sums[i]))); tip.append(all);
        tip.hidden = false;
        const hr = host.getBoundingClientRect(); let tx = ev.clientX - hr.left + 14; if (tx + 200 > hr.width) tx = ev.clientX - hr.left - 214; tip.style.left = `${Math.max(4, tx)}px`; tip.style.top = '8px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}

/** The Overview's panel: cost by team, each interval, stacked, with a legend that is a list of the teams and what each cost (a click brings a fill forward). */
export function drawOverviewPanel(host, { phone }) {
    host.replaceChildren();
    const st = seriesState('overview');
    if (st.error) { const e = el('p', 'empty-state', st.error); e.setAttribute('role', 'status'); host.append(e); return; }
    if (!st.data) return;
    const { buckets, interval, sinceMs, untilMs } = st.data;
    if (!buckets.length || !st.ranked.length) return;
    const times = axis(sinceMs, untilMs, interval);
    const lines = buildSeries(buckets, assignLines(st.ranked, null), times, 'cost_usd', false);
    const card = el('div', 'viz-card');
    card.append(el('h4', 'viz-title', `Cost ${wordFor(interval)}, stacked by team`));
    const chart = el('div', 'viz-chart'); card.append(chart);
    const ul = el('ul', 'viz-legend');
    lines.forEach((l, k) => {
        const li = el('li'), b = el('button', 'btn btn-quiet viz-legend-btn'); b.type = 'button'; b.setAttribute('aria-pressed', String(st.hi === l.key)); b.setAttribute('aria-label', `Highlight ${l.label}'s line, ${METRICS[0].fmt(l.total)}`); // the name and the figure read apart (they were "coral-go-team$13.50")
        const sw = el('i', 'cost-swatch'); sw.style.background = colorOf(l); sw.setAttribute('aria-hidden', 'true');
        b.append(sw, el('span', 'viz-legend-name', l.label), el('span', 'viz-legend-value', METRICS[0].fmt(l.total)));
        b.addEventListener('click', () => { st.hi = st.hi === l.key ? '' : l.key; drawOverviewPanel(host, { phone }); });
        li.append(b); ul.append(li);
    });
    card.append(ul); host.append(card);
    drawArea(chart, { times, lines, metric: 'cost_usd', interval, hi: st.hi, phone });
}


// ── bars, for the agent drill-down ───────────────────────────────────────

/** Whether the share of the input that came from the cache: read / (input + read), as a number from 0 to 1, or null when there was no input. */
export function cacheHit(input, cacheRead) { const i = Number(input) || 0, r = Number(cacheRead) || 0; return i + r > 0 ? r / (i + r) : null; }

/** The window a clicked bar stands for: its bucket's start and the next one's (the end is exclusive), as the server reads them. */
export function bucketWindow(startMs, interval) { return { since: new Date(startMs).toISOString(), until: new Date(startMs + (STEP_MS[interval] || STEP_MS['1h'])).toISOString() }; }

/** Stacked bars (the parts of one bar, bottom to top, 2 px of surface between them, the top rounded), one per time of the axis; a tooltip per bar; a click on a bar picks it (onPick(i)), the picked one outlined
 *  (sel). parts = [{ name, color, vals }]. The chart is aria-hidden: whatever it says is also a table or a control beside it. */
export function drawBars(host, { times, parts, fmt, interval, sel, onPick, phone, xLabel }) {
    host.replaceChildren();
    const W = Math.max(280, Math.round(host.clientWidth || (phone ? 340 : 880))), H = phone ? 150 : 170, L = 52, R = 8, T = 10, B = 22, pw = W - L - R, ph = H - T - B, N = times.length;
    const label = xLabel || (i => timeLabel(times[i], interval));
    const sums = times.map((_, i) => parts.reduce((a, p) => a + p.vals[i], 0));
    const max = niceMax(Math.max(0, ...sums) * 1.05), y = v => T + ph - (v / max) * ph, bw = Math.max(2, pw / Math.max(N, 1) - 2);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false', class: 'viz-svg' });
    for (let g = 0; g <= 3; g++) { const v = (max / 3) * g; s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'viz-grid' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' }, axisLabel(fmt, v))); }
    const tip = el('div', 'viz-tip'); tip.hidden = true;
    const ticks = N <= 1 ? [0] : [0, Math.round((N - 1) / 3), Math.round(((N - 1) * 2) / 3), N - 1].filter((v, i, a) => a.indexOf(v) === i).slice(0, phone ? 3 : 4);
    for (let i = 0; i < N; i++) {
        const x0 = L + (i / N) * pw + 1, g = svg('g');
        let acc = 0;
        const live = parts.filter(p => p.vals[i] > 0);
        live.forEach((p, k) => {
            const y1 = y(acc + p.vals[i]), y0 = y(acc) - (k > 0 ? 2 : 0), rh = Math.max(1, y0 - y1), top = k === live.length - 1, r = Math.min(4, rh, bw / 2);
            g.append(svg('path', { d: top ? `M${x0} ${y0} V${y1 + r} Q${x0} ${y1} ${x0 + r} ${y1} H${x0 + bw - r} Q${x0 + bw} ${y1} ${x0 + bw} ${y1 + r} V${y0} Z` : `M${x0} ${y0} V${y1} H${x0 + bw} V${y0} Z`, fill: p.color, class: 'viz-bar', opacity: sel != null && sel !== i ? 0.45 : 1 }));
            acc += p.vals[i];
        });
        if (sel === i) g.append(svg('rect', { x: x0 - 2, y: T, width: bw + 4, height: ph, class: 'viz-pick', rx: 4, fill: 'none' }));
        const hit = svg('rect', { x: x0 - 1, y: T, width: bw + 2, height: ph, fill: 'transparent' }); if (onPick) hit.style.cursor = 'pointer';
        hit.addEventListener('pointermove', ev => {
            tip.replaceChildren(el('div', 'viz-tip-when', label(i)));
            for (const p of parts) { const row = el('div', 'viz-tip-row'), key = el('i'); key.style.background = p.color; const name = el('span'); name.append(key, document.createTextNode(p.name)); row.append(name, el('b', null, fmt(p.vals[i]))); tip.append(row); }
            tip.hidden = false; const hr = host.getBoundingClientRect(); let tx = ev.clientX - hr.left + 14; if (tx + 200 > hr.width) tx = ev.clientX - hr.left - 214; tip.style.left = `${Math.max(4, tx)}px`; tip.style.top = '4px';
        });
        hit.addEventListener('pointerleave', () => { tip.hidden = true; });
        if (onPick) hit.addEventListener('click', () => onPick(i));
        g.append(hit); s.append(g);
        if (ticks.includes(i)) s.append(svg('text', { x: x0 + bw / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === N - 1 ? 'end' : 'middle', class: 'viz-axis' }, label(i)));
    }
    host.classList.add('viz-host'); host.append(s, tip);
}
