/* The agent drill-down (#7930, the operator's mock): from By agent's "Details" to one agent over the range: cost turn by turn through its session, cost each hour (a click on a bar, or the "Turns in" select, picks
 * an hour), and the biggest turns of the hour picked (or of the whole range) as a table; Tool calls and Cache hit under "More charts". The charts are aria-hidden: the tiles, the select and the table are
 * their text. Reads /api/token-usage/session/{id}/turns, /api/token-usage/timeseries?group_by=agent, /api/token-usage/turns?agent=... and /api/call-metrics/summary?interval=...&agent=... (#7803). Everything is
 * built with the DOM and textContent: names are written by agents. */
import { importOnce } from './import_once.js';
import { compactFigure as compactCount, formatCost } from './format.js'; // the one Analytics figure format (#9516)
import { isPhoneLayout } from './phone_layout.js';
const { dataTable, tableState, timeCell } = await importOnce('./data_table.js');
const series = await importOnce('./analytics_series.js');
const views = await importOnce('./analytics_views.js');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const money = v => formatCost(v, { zeroAsTwo: true });
const pct = v => `${Math.round(v * 100)}%`;
const RANGES = { hour: { hours: 1, interval: '5m', word: 'last hour' }, day: { hours: 24, interval: '1h', word: 'last 24 hours' }, week: { hours: 168, interval: '1h', word: 'last 7 days' }, month: { hours: 720, interval: '1d', word: 'last 30 days' } };

const st = { row: null, period: 'day', buckets: [], turns: [], calls: null, picked: -1, biggest: null, error: {}, seq: 0, loaded: false };

const host = () => document.getElementById('cost-agent-detail');
const agentKey = row => row.agent_name || '(unknown)';
const agentName = row => row.display_name || row.agent_name || 'Agent';

/** Opens the drill-down for a By agent row. */
export async function openAgent(row, period) {
    st.row = row; st.period = RANGES[period] ? period : 'day'; st.buckets = []; st.turns = []; st.calls = null; st.picked = -1; st.biggest = null; st.error = {}; st.loaded = false; st.untilMs = Date.now();
    views.selectView('agent-detail');
    const title = document.getElementById('cost-view-title'); if (title) title.textContent = agentName(row);
    draw();
    await load();
}

async function read(url) { const resp = await fetch(url, { cache: 'no-store' }); if (!resp.ok) throw new Error('unavailable'); return resp.json(); }

async function load() {
    const my = ++st.seq, r = RANGES[st.period], row = st.row, untilMs = st.untilMs, sinceMs = untilMs - r.hours * 3600000, since = encodeURIComponent(new Date(sinceMs).toISOString());
    st.sinceMs = sinceMs;
    const set = (k, p) => p.catch(() => { st.error[k] = true; return null; });
    const [turns, ts, calls] = await Promise.all([
        row.session_id ? set('turns', read(`/api/token-usage/session/${encodeURIComponent(row.session_id)}/turns`)) : Promise.resolve(null),
        set('hours', read(`/api/token-usage/timeseries?since=${since}&interval=${r.interval}&group_by=agent`)),
        set('calls', read(`/api/call-metrics/summary?interval=${r.interval === '1d' ? '1d' : '1h'}&hours=${r.hours}&agent=${encodeURIComponent(agentName(row))}`)),
    ]);
    if (my !== st.seq) return; // another agent was opened meanwhile
    // the turns of the range, their running cost starting at nothing where the range starts: the line ends on the Cost tile, which is the range's too (the route sends the whole session)
    let run = 0;
    st.turns = ((turns && turns.turns) || []).filter(t => Date.parse(t.timestamp) >= sinceMs).map((t, i) => ({ ...t, turn: i + 1, cumulative_cost: (run += t.cost_usd || 0) }));
    st.buckets = ts ? (ts.buckets || []).map(b => ({ t: Date.parse(b.bucket), s: (b.series || []).find(x => x.key === agentKey(row)) })).filter(b => b.s) : [];
    st.calls = calls ? calls.buckets || [] : null;
    await loadBiggest();
    st.loaded = true;
    draw();
}

async function loadBiggest() {
    const my = ++st.seq, row = st.row, r = RANGES[st.period];
    const win = st.picked >= 0 && st.times[st.picked] != null ? series.bucketWindow(st.times[st.picked], r.interval) : { since: new Date(st.sinceMs).toISOString(), until: new Date(st.untilMs).toISOString() };
    try {
        const data = await read(`/api/token-usage/turns?agent=${encodeURIComponent(row.agent_name || '')}&since=${encodeURIComponent(win.since)}&until=${encodeURIComponent(win.until)}&order=cost&limit=20`);
        if (my !== st.seq) return; st.biggest = data.turns || []; delete st.error.biggest;
    } catch { if (my === st.seq) { st.biggest = null; st.error.biggest = true; } }
}

const msg = text => { const p = el('p', 'empty-state', text); p.setAttribute('role', 'status'); return p; };
const card = (title, hint) => { const c = el('section', 'viz-card viz-card-stack'); c.append(el('h4', 'viz-title', title)); if (hint) c.append(el('p', 'viz-hint', hint)); return c; };
const tile = (label, value, sub) => { const t = el('div', 'viz-tile'); t.append(el('div', 'viz-tile-label', label), el('div', 'viz-tile-value', value)); if (sub) t.append(el('div', 'viz-tile-sub', sub)); return t; };

function draw() {
    const h = host(); if (!h) return;
    h.replaceChildren();
    const row = st.row, r = RANGES[st.period], phone = isPhoneLayout();
    if (!row) return;
    const heading = document.getElementById('cost-view-title'); if (heading) heading.textContent = agentName(row); // the page's title is the agent
    const back = el('button', 'back-link viz-back'); back.type = 'button'; { const arrow = el('span', null, '\u2190'); arrow.setAttribute('aria-hidden', 'true'); back.append(arrow, document.createTextNode(' Overview')); } // the back link of the page, as everywhere else
    back.addEventListener('click', () => views.selectView('agent', { focus: true }));
    const about = [row.board_name ? `Team ${row.board_name}` : '', row.folder || ''].filter(Boolean).join(' \u00b7 '); // the range is under the page's title
    h.append(back);
    if (about) h.append(el('p', 'viz-sub', about));

    // tiles: what the By agent row says, and the cache hit
    const tiles = el('div', 'viz-tiles');
    const hit = series.cacheHit(row.input_tokens, row.cache_read_tokens);
    tiles.append(tile('Cost', money(row.cost_usd || 0), `${compactCount(row.requests || 0)} requests`), tile('Tokens', compactCount((row.input_tokens || 0) + (row.output_tokens || 0)), `${compactCount(row.input_tokens || 0)} in, ${compactCount(row.output_tokens || 0)} out`),
        tile('Cache read', compactCount(row.cache_read_tokens || 0), hit == null ? '' : `${pct(hit)} of the input`), tile('Cache write', compactCount(row.cache_write_tokens || 0)));
    h.append(tiles);

    // 1. cost over the session, turn by turn
    const c1 = card(`Cost turn by turn, ${r.word}`);
    if (!row.session_id) c1.append(msg('This row has no session to read turns from.'));
    else if (st.error.turns) c1.append(msg('The turns are unavailable.'));
    else if (st.turns.length < 2) c1.append(msg(st.loaded ? 'Fewer than two turns are recorded for this session in this range.' : 'Loading…'));
    else {
        const chart = el('div', 'viz-chart'); c1.append(chart);
        const turns = st.turns, line = { key: 'cost', label: 'Running cost', other: false, plot: turns.map(t => t.cumulative_cost), vals: turns.map(t => t.cost_usd) };
        const dear = turns.reduce((b, t) => (t.cost_usd > b.cost_usd ? t : b), turns[0]);
        c1.append(el('p', 'viz-sr', `${turns.length} turns, ${money(turns[turns.length - 1].cumulative_cost)} in all; the dearest turn was number ${dear.turn}, ${money(dear.cost_usd)}.`));
        h.append(c1);
        series.drawChart(chart, { times: turns.map(t => Date.parse(t.timestamp)), lines: [{ ...line, total: line.plot[line.plot.length - 1] }], metric: 'cost_usd', interval: '1h', phone, xLabel: i => `turn ${turns[i].turn}`, when: i => `Turn ${turns[i].turn} · ${money(turns[i].cost_usd)} this turn`, fmt: money });
    }
    if (!c1.isConnected) h.append(c1);

    // 2. cost each interval; a click picks one
    const c2 = card(`Cost ${series.wordFor(r.interval)}`, 'Click an hour, or choose it in the select, to see its biggest turns below.');
    if (st.error.hours) c2.append(msg('The cost over time is unavailable.'));
    else if (!st.buckets.length) c2.append(msg('No usage over time in this range.'));
    else {
        st.times = series.axis(st.sinceMs, st.untilMs, r.interval);
        const at = new Map(st.times.map((t, i) => [t, i])), vals = new Array(st.times.length).fill(0);
        for (const b of st.buckets) { const i = at.get(b.t); if (i != null) vals[i] += b.s.cost_usd || 0; }
        const pick = el('div', 'viz-ctl'); pick.append(el('label', 'viz-ctl-label', 'Turns in'));
        const sel = el('select', 'field field-dense viz-select'); sel.id = 'cost-agent-window'; pick.firstChild.htmlFor = sel.id;
        const whole = el('option', null, 'The whole range'); whole.value = ''; sel.append(whole);
        st.times.map((t, i) => ({ t, i, v: vals[i] })).filter(x => x.v > 0).sort((a, b) => b.t - a.t).slice(0, 72).forEach(x => { const o = el('option', null, `${series.timeLabel(x.t, r.interval)} · ${money(x.v)}`); o.value = String(x.i); sel.append(o); });
        sel.value = st.picked >= 0 ? String(st.picked) : '';
        sel.addEventListener('change', async () => { st.picked = sel.value === '' ? -1 : Number(sel.value); await loadBiggest(); draw(); });
        pick.append(sel); c2.append(pick);
        const chart = el('div', 'viz-chart'); c2.append(chart);
        const dearI = vals.indexOf(Math.max(...vals));
        c2.append(el('p', 'viz-sr', `${money(vals.reduce((a, b) => a + b, 0))} in all; the dearest ${r.interval === '1d' ? 'day' : 'hour'} was ${series.timeLabel(st.times[dearI], r.interval)}, ${money(vals[dearI])}.`));
        h.append(c2);
        series.drawBars(chart, { times: st.times, parts: [{ name: 'Cost', color: 'var(--viz-1)', vals }], fmt: money, interval: r.interval, sel: st.picked >= 0 ? st.picked : null, phone, onPick: async i => { if (vals[i] <= 0) return; st.picked = st.picked === i ? -1 : i; await loadBiggest(); draw(); } });
    }
    if (!c2.isConnected) h.append(c2);

    // the biggest turns of the hour picked, or of the range
    const win = st.picked >= 0 && st.times && st.times[st.picked] != null ? series.timeLabel(st.times[st.picked], r.interval) : r.word;
    const title = el('h4', 'viz-title viz-table-title', `Biggest turns, ${win}`); h.append(title);
    if (st.error.biggest) h.append(msg('The turns are unavailable.'));
    else if (st.biggest == null) h.append(msg('Loading…'));
    else if (!st.biggest.length) h.append(msg('No turn in this window.'));
    else {
        const num = (key, label, extra) => ({ key, label, numeric: true, sort: 'number', firstDir: 'desc', sortValue: t => t[key] || 0, cell: t => compactCount(t[key] || 0), ...extra });
        const state = tableState(); state.sort = { key: 'cost_usd', dir: 'desc' };
        h.append(dataTable({ label: 'Biggest turns', fold: 'labeled', scroll: true, state, rows: st.biggest, rowKey: t => `${t.session_id}|${t.timestamp}|${t.cost_usd}`, ...views.phoneOneLine([
            { key: 'timestamp', label: 'Time', tone: 'primary', sort: 'date', sortValue: t => t.timestamp, cell: t => timeCell(t.timestamp), firstDir: 'desc' },
            num('cost_usd', 'Cost', { cell: t => money(t.cost_usd || 0), foldFirst: true }),
            { key: 'model', label: 'Model', sort: true, sortValue: t => t.model || '', cell: t => t.model || '—', tone: 'secondary' },
            num('input_tokens', 'Input'), num('output_tokens', 'Output'), num('cache_read_tokens', 'Cache read', { narrowHide: true }), num('cache_write_tokens', 'Cache write', { narrowHide: true }),
        ], ['cost_usd']) }).el);
    }

    // more charts: tool calls, cache hit
    const more = el('details', 'disclosure viz-more'); more.append(el('summary', null, 'More charts'));
    const t1 = card(`Tool calls ${series.wordFor(r.interval)}`, 'The calls that failed are drawn on top, in the error colour.');
    if (st.calls == null) t1.append(msg(st.error.calls ? 'The tool calls are unavailable.' : 'Loading…'));
    else if (!st.calls.length) t1.append(msg('No tool call in this range.'));
    else {
        const times = series.axis(st.sinceMs, st.untilMs, r.interval === '1d' ? '1d' : '1h'), at = new Map(times.map((t, i) => [t, i])), ok = new Array(times.length).fill(0), bad = new Array(times.length).fill(0);
        for (const b of st.calls) { const i = at.get(Date.parse(b.bucket)); if (i != null) { ok[i] += (b.calls || 0) - (b.errors || 0); bad[i] += b.errors || 0; } }
        const chart = el('div', 'viz-chart'); t1.append(chart);
        t1.append(el('p', 'viz-sr', `${compactCount(ok.reduce((a, b) => a + b, 0) + bad.reduce((a, b) => a + b, 0))} calls, ${compactCount(bad.reduce((a, b) => a + b, 0))} failed.`));
        more.append(t1);
        series.drawBars(chart, { times, parts: [{ name: 'Succeeded', color: 'var(--viz-3)', vals: ok }, { name: 'Failed', color: 'var(--danger)', vals: bad }], fmt: compactCount, interval: r.interval === '1d' ? '1d' : '1h', phone });
    }
    if (!t1.isConnected) more.append(t1);
    const t2 = card(`Cache hit ${series.wordFor(r.interval)}`, 'The share of the input read from the cache; a drop is a cold start or an edited prompt.');
    if (st.error.hours || !st.buckets.length) t2.append(msg(st.error.hours ? 'The cache hit is unavailable.' : 'No usage in this range.'));
    else {
        const times = series.axis(st.sinceMs, st.untilMs, r.interval), at = new Map(times.map((t, i) => [t, i])), vals = new Array(times.length).fill(null);
        for (const b of st.buckets) { const i = at.get(b.t), v = series.cacheHit(b.s.input_tokens, b.s.cache_read_tokens); if (i != null && v != null) vals[i] = v * 100; }
        const known = vals.map((v, i) => [v, i]).filter(x => x[0] != null);
        if (known.length < 2) t2.append(msg('Not enough hours with input to draw a line.'));
        else {
            const chart = el('div', 'viz-chart'); t2.append(chart); more.append(t2);
            const plot = known.map(x => x[0]), tt = known.map(x => times[x[1]]);
            t2.append(el('p', 'viz-sr', `Cache hit from ${Math.round(Math.min(...plot))}% to ${Math.round(Math.max(...plot))}%.`));
            series.drawChart(chart, { times: tt, lines: [{ key: 'hit', label: 'Cache hit', other: false, plot, vals: plot, total: 0 }], metric: 'cost_usd', interval: r.interval, phone, fmt: v => `${Math.round(v)}%` });
        }
    }
    if (!t2.isConnected) more.append(t2);
    h.append(more);
}
