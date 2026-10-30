/* The drawing helpers of the Analytics tabs Usage, Operator interaction and Team communication (#11222): a KPI strip, a stacked bar chart one bar a day with a previous/next day picker, ranked bars,
 * a who-talks-to-whom grid. One look for all three: the series colours are Coral's --viz tokens, every series after the fourth also has a stripe so no two are told apart by colour alone,
 * every series is named in the legend, and the charts are aria-hidden: the picker, the ranked bars and the tables beside them are their text. Everything is built with the DOM and textContent:
 * names are written by agents. */

import { importOnce } from './import_once.js';
const { dataTable, tableState } = await importOnce('./data_table.js'); // the shared table (#7743)
const SVG = 'http://www.w3.org/2000/svg';
const SVG_PATTERN = 'pat' + 'tern'; // the SVG element's name, written in two parts: the icon scanner (icon_names.mjs) reads a lone word in quotes as a Material icon's name
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text != null) e.textContent = text; return e; };
export { el };

/** The colour of the i-th series: --viz-1 to --viz-7, then the neutral one (the "Other" series). */
export const seriesColor = (i) => (i < 7 ? `var(--viz-${i + 1})` : 'var(--viz-other)');
/** The series after the fourth carry a stripe over their colour, so a colour-blind reader tells them apart. */
export const striped = (i) => i >= 4;

let ids = 0;

/** A KPI strip: items [{label, value, sub, delta, good, note}]: `delta` is a sentence ("12% more than the 7 days before"), `good` says whether more is good (null: neither), the small line under it (where it comes from). */
export function kpiStrip(items) {
    const row = el('div', 'atab-kpis');
    for (const k of items) {
        const t = el('div', 'atab-kpi' + (k.pending ? ' atab-kpi-pending' : ''));
        t.append(el('span', 'atab-kpi-k', k.label), el('span', 'atab-kpi-v', k.value));
        if (k.delta) t.append(el('span', 'atab-kpi-d ' + (k.good == null ? 'atab-flat' : k.good ? 'atab-good' : 'atab-bad'), k.delta));
        if (k.note) t.append(el('span', 'atab-kpi-n', k.note));
        row.append(t);
    }
    return row;
}

/** "12% more", "3% less" for a change from `prev` to `cur`; '' when there is nothing to compare. */
export function changeWords(cur, prev) {
    if (!(prev > 0) || !Number.isFinite(cur)) return '';
    const p = Math.round((cur - prev) / prev * 100);
    return p === 0 ? 'same as before' : p > 0 ? `${p}% more` : `${-p}% less`;
}

/** The legend: every series, by name, with the swatch it has in the chart. */
export function legend(series) {
    const l = el('ul', 'atab-legend');
    series.forEach((s, i) => {
        const li = el('li');
        const sw = el('i', 'atab-sw' + (striped(i) ? ' atab-sw-stripe' : '')); sw.style.setProperty('--c', seriesColor(i)); sw.setAttribute('aria-hidden', 'true');
        li.append(sw, document.createTextNode(s.name));
        l.append(li);
    });
    return l;
}

/** One bar a day, stacked by series. rows: [{label, values: {key: n}}]; series: [{key, name}]; the label is shown under every `step`-th bar (never every bar: they overlap at 14 days or more). */
export function stackedBars(rows, series, { fmt = String, selected = -1, onPick = null, phone = false, label = 'Chart' } = {}) {
    const W = phone ? 360 : 760, H = phone ? 220 : 240, pl = 40, pb = 24, pt = 10, iw = W - pl - 6, ih = H - pb - pt;
    const totals = rows.map(r => series.reduce((n, s) => n + (r.values[s.key] || 0), 0));
    const max = niceMax(Math.max(0, ...totals));
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'atab-svg', 'aria-hidden': 'true', focusable: 'false' });
    const pid = 'atab-p' + (++ids);
    const defs = sv('defs'); const pat = sv(SVG_PATTERN, { id: pid, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 2, height: 5, class: 'atab-stripe' })); defs.append(pat); svg.append(defs);
    for (let g = 0; g <= 4; g++) {
        const y = pt + ih - ih * g / 4;
        svg.append(sv('line', { x1: pl, x2: W - 6, y1: y, y2: y, class: 'atab-grid' }), sv('text', { x: pl - 6, y: y + 4, 'text-anchor': 'end', class: 'atab-axis' }, fmt(max * g / 4)));
    }
    const bw = iw / Math.max(rows.length, 1), step = Math.max(1, Math.ceil(rows.length / (phone ? 4 : 8)));
    rows.forEach((r, i) => {
        const x = pl + i * bw + bw * 0.15, w = bw * 0.7;
        let y = pt + ih;
        series.forEach((s, j) => {
            const v = r.values[s.key] || 0, h = max > 0 ? ih * v / max : 0;
            if (h <= 0) return;
            y -= h;
            const rect = sv('rect', { x: x.toFixed(1), y: y.toFixed(1), width: w.toFixed(1), height: Math.max(h - 0.6, 0).toFixed(1), class: 'atab-bar' });
            rect.style.fill = seriesColor(j);
            svg.append(rect);
            if (striped(j)) svg.append(sv('rect', { x: x.toFixed(1), y: y.toFixed(1), width: w.toFixed(1), height: Math.max(h - 0.6, 0).toFixed(1), fill: `url(#${pid})`, class: 'atab-bar-stripe' }));
        });
        if (i === selected) svg.append(sv('rect', { x: (x - 3).toFixed(1), y: pt, width: (w + 6).toFixed(1), height: ih, rx: 3, class: 'atab-sel' }));
        if (i % step === 0) svg.append(sv('text', { x: (x + w / 2).toFixed(1), y: H - 7, 'text-anchor': 'middle', class: 'atab-axis' }, r.label));
        if (onPick) { const hit = sv('rect', { x: pl + i * bw, y: pt, width: bw, height: ih, class: 'atab-hit' }); hit.addEventListener('click', () => onPick(i)); svg.append(hit); }
    });
    svg.setAttribute('data-label', label);
    return svg;
}

function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** The previous/next day buttons (44 px, and the keyboard's) and the sentence for the day picked: `texts[i]` is what day i says. */
export function dayPicker(rows, selected, texts, onChange) {
    const bar = el('div', 'atab-days');
    const prev = el('button', 'btn', 'Previous day'), next = el('button', 'btn', 'Next day');
    prev.type = next.type = 'button';
    prev.disabled = selected <= 0; next.disabled = selected >= rows.length - 1;
    prev.addEventListener('click', () => onChange(selected - 1)); next.addEventListener('click', () => onChange(selected + 1));
    const say = el('span', 'atab-day-say'); say.setAttribute('role', 'status'); say.textContent = texts[selected] || '';
    bar.append(prev, say, next);
    return bar;
}

/** Ranked bars: rows [{name, value, text, i}] against the largest; the colour and stripe of series i. */
export function rankedBars(rows) {
    const list = el('ul', 'atab-ranked');
    const max = Math.max(0, ...rows.map(r => r.value));
    for (const r of rows) {
        const li = el('li', 'atab-rank');
        const name = el('span', 'atab-rank-name', r.name);
        const track = el('span', 'atab-rank-track'); const fill = el('i', 'atab-rank-fill' + (striped(r.i ?? 0) ? ' atab-sw-stripe' : '')); fill.style.width = (max > 0 ? Math.max(2, r.value / max * 100) : 0) + '%'; fill.style.setProperty('--c', seriesColor(r.i ?? 0));
        track.append(fill);
        li.append(name, track, el('span', 'atab-rank-n', r.text));
        list.append(li);
    }
    return list;
}

/** The who-talks-to-whom grid: names (rows send, columns receive), cells[i][j] counts. Cell text is always the page's text colour on a tint of at most 45% of the accent, so it holds 4.5:1 in both themes. On a phone the grid is
 *  a ranked list of pairs instead (`pairs`: [{name, value, text}]). */
export function matrix(names, cells, { phone = false } = {}) {
    if (phone) {
        const pairs = [];
        names.forEach((a, i) => names.forEach((b, j) => { if (i !== j && cells[i][j] > 0) pairs.push({ name: `${a} → ${b}`, value: cells[i][j], text: String(cells[i][j]), i: 0 }); }));
        pairs.sort((x, y) => y.value - x.value);
        return rankedBars(pairs.slice(0, 12));
    }
    const max = Math.max(1, ...cells.flat());
    const wrap = el('div', 'atab-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Who talks to whom: rows send, columns receive');
    const g = el('div', 'atab-matrix'); g.style.gridTemplateColumns = `minmax(7rem, auto) repeat(${names.length}, minmax(3.2rem, 1fr))`;
    g.append(el('span', 'atab-mx-corner', 'Sender ↓ · receiver →'));
    names.forEach(n => g.append(el('span', 'atab-mx-h', n)));
    names.forEach((a, i) => {
        g.append(el('span', 'atab-mx-r', a));
        names.forEach((b, j) => {
            const c = el('span', 'atab-mx-c', i === j ? '' : (cells[i][j] ? String(cells[i][j]) : '·'));
            if (i !== j) c.style.setProperty('--mix', (cells[i][j] ? 8 + Math.round(cells[i][j] / max * 37) : 0) + '%');
            if (i !== j) c.title = `${a} to ${b}: ${cells[i][j]}`;
            g.append(c);
        });
    });
    wrap.append(g);
    return wrap;
}

/** A table, drawn by the shared data table (data_table.js): rows is an array of arrays of text; `right` lists the right-aligned (numeric) column indexes. It scrolls in its own box and says so; a phone row is 44 px. */
export function plainTable(head, rows, { right = [], label = 'Table' } = {}) {
    const columns = head.map((h, i) => ({ key: 'c' + i, label: h || '\u00a0', numeric: right.includes(i), tone: i === 0 ? 'primary' : undefined, cell: r => r['c' + i] }));
    const t = dataTable({ label, rowKey: r => r.__i, state: tableState(), fold: 'labeled', scroll: true, columns, rows: rows.map((r, n) => Object.fromEntries([['__i', n], ...r.map((c, i) => ['c' + i, c])])) });
    const frame = el('div', 'atab-tframe'), hint = el('p', 'atab-hint', 'Scroll sideways for more columns.');
    hint.hidden = true; // shown only when the table really overflows (a phone stacks it into rows: nothing to scroll)
    frame.append(t.el, hint);
    watchOverflow(frame, hint);
    return frame;
}

/** The scroll hint follows the table: shown while any box in `frame` is wider than its window, checked when it is added and whenever the frame is resized. */
function watchOverflow(frame, hint) {
    const check = () => { hint.hidden = ![frame, ...frame.querySelectorAll('*')].some(e => e !== hint && e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)); };
    requestAnimationFrame(() => { if (!frame.isConnected) return; check(); if (typeof ResizeObserver === 'function') new ResizeObserver(check).observe(frame); });
}

/** A panel: a heading (and a small line after it) over its content. */
export function panel(title, sub, ...content) {
    const p = el('section', 'atab-card'); const h = el('h3', 'atab-h'); h.append(document.createTextNode(title));
    if (sub) h.append(el('small', null, sub));
    p.append(h, ...content);
    return p;
}

/** A label and a select. options: [[value, text]]. */
export function selectField(label, options, value, onChange) {
    const l = el('label', 'atab-field'); l.append(el('span', null, label));
    const s = el('select', 'field field-dense'); s.setAttribute('aria-label', label);
    for (const [v, t] of options) s.append(new Option(t, v));
    s.value = value; s.addEventListener('change', () => onChange(s.value));
    l.append(s);
    return l;
}

/** A row of buttons, one pressed: options [[value, text]]. */
export function segment(label, options, value, onChange) {
    const g = el('div', 'atab-seg btn-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    for (const [v, t] of options) { const b = el('button', 'btn', t); b.type = 'button'; b.setAttribute('aria-pressed', String(v === value)); b.addEventListener('click', () => onChange(v)); g.append(b); }
    return g;
}
