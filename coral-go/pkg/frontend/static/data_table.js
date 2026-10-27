/* The one table (#7743): every list or table surface passes what to show, the component owns how it looks and behaves. The operator's rule: a styling change is one token or one rule, so every size and colour here
 * is a --table-* token (css/data_table.css) and no surface styles a row, a cell or a header.
 *
 *   dataTable({ label, columns, rows, rowKey, groupBy(row) -> { key, label }, open, current, state, onSort, layout, fold, foldAt, sortBar, defaultSortLabel, bare, empty, footer, selectable, rowName, quiet, scroll, detail, decorate, decorateHead }) -> { el, bar, selectButton, selection(), clear(), state }
 *   selectable = { contextKey, onChange(keys), actions: [{ label, run(rows, keys, value), danger, confirm, choose: { label, options() -> [{ value, label }] } }] }: a danger action confirms in the bar, a choose action asks for its value there.
 *   Column = { key, label, field | cell(row, ctx), primary, tone: 'primary'|'secondary'|'tertiary', width: 'grow'|'content'|'<n>rem', nowrap, align: 'start'|'end', numeric,
 *              sort: true|'number'|'date'|fn(a, b), sortValue(row), firstDir: 'asc'|'desc', foldFirst, narrowHide, line: 0|1|2, when(row), subtitle(row), title(row), filter: { label, active(), open(button) }, hideLabel }
 *   column widths (#7949): every header has a resize handle on its right edge (drag, Left and Right keys, double-click or Enter to fit the content); the widths are kept per list in this browser (widthsKey, else the label without its row count), and "Reset column widths" appears while any are set. minWidth per column (64 px by default), resize: false for one that must not.
 *   detail = { id(row), open(row) -> bool, render(row) -> Node }: a second full-width row under each row (hidden while open(row) is false); the surface's own toggle in a cell opens it (Coral Hub's Servers: health, what applies).
 *   decorate(row, tr, detailTr) and decorateHead(th, column): called each time the rows (or the header) are drawn, for the hooks a surface keeps on them.
 *   cell types: chip(word, cls), avatar(name), avatars(people, label), personButton(name, label), tag(text), timeCell(stamp), link(text, run), primaryButton(text, label)
 *   oneLine: true: keep one row, hide columns with dropAt 62/52/36/28 (rem) as the container narrows; never fold.
 *   compact: true: a folded column row is two compact lines (60 px; the name on one line): the Tasks lists and the dock's Artifacts ask for it (#8496); other folded tables keep two-line names and descriptions.
 *   state: tableState(), kept by the caller across redraws: the sort, and the selection (a set of row keys, kept while the rows are filtered or paged, cleared when selectable.contextKey changes).
 * Folded (the table's own box narrower than foldAt rem, 40 by default; 'fit' measures the unfolded columns; also at 200% text): fold 'column' is the two-line row (line 1 and line 2 cells), fold 'labeled' is the name, then "label value" lines
 * (the Analytics tables); scroll: a table of many columns scrolls sideways inside its box, shaded where more is to come, rather than being cut off; the header row is hidden and a "Sort by" select takes its place. Everything is built with the DOM and textContent: titles and names are written by agents. */
import { whenText } from './when_text.js';
import { browserLocal } from './safe_storage.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

export const tableState = () => ({ widths: null, sort: null, selected: new Set(), rowCache: new Map(), anchor: null, ctx: undefined, select: false, confirming: -1 });

// ── cell types ────────────────────────────────────────────────────────────
/** The row's one real button: its text names the row. */
export function primaryButton(text, label) {
    const b = el('button', 'dt-primary', text); b.type = 'button';
    b.title = text; // a name the row cuts with an ellipsis is read whole on hover (#8206); a caller with better words sets its own
    if (label) b.setAttribute('aria-label', label);
    return b;
}
/** A state as a dot and a word (the dot is decoration: the word says it). */
export function chip(word, cls) {
    const c = el('span', `chip dt-chip goal-chip ${cls || ''}`.trim());
    const dot = el('span', 'goal-dot'); dot.setAttribute('aria-hidden', 'true');
    c.append(dot, document.createTextNode(word));
    return c;
}
export function tag(text) { return el('span', 'chip chip-tag dt-tag', text); }
// white 11/700 on each of these is 4.5:1 or more
// the eight colours are --avatar-1 .. --avatar-8 (variables.css): white 11/700 on each is 4.5:1 or more
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
/** A person: a 20 px circle with the first letter, one fixed colour per name, then the name. */
export function avatar(name, text) {
    const w = el('span', 'dt-person');
    const n = String(name || '').trim();
    if (!n) { w.textContent = text || ''; return w; }
    const a = el('span', 'dt-avatar', [...n][0].toUpperCase()); a.setAttribute('aria-hidden', 'true'); a.style.background = `var(--avatar-${(hash(n.toLowerCase()) % 8) + 1})`;
    w.append(a, el('span', 'dt-person-name', text || n)); // text: what is said beside the circle when it is more than the name ("Done by Dev")
    return w;
}
/** People as a row of circles and nothing else (the Tasks table's Assigned to, #8492): the person responsible first, one solid circle; then reviewers as smaller outlined circles, at most two, then "+N". The whole cell is one image named by label
 *  ("Done by Dev, reviewed by QA"), which is also its hover text, so the column is as narrow as its circles. people = [{ name, review? }]. */
export function avatars(people, label) {
    const w = el('span', 'dt-person dt-avatars'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', label); w.title = label;
    const circle = (name, cls) => { const n = String(name || '').trim(); const a = el('span', `dt-avatar${cls}`, [...n][0].toUpperCase()); a.setAttribute('aria-hidden', 'true'); a.style.setProperty('--dt-avatar-bg', `var(--avatar-${(hash(n.toLowerCase()) % 8) + 1})`); return a; };
    const named = people.filter(p => p && String(p.name || '').trim());
    for (const p of named.filter(x => !x.review)) w.append(circle(p.name, ''));
    const reviewers = named.filter(x => x.review);
    for (const p of reviewers.slice(0, 2)) w.append(circle(p.name, ' dt-avatar-review'));
    if (reviewers.length > 2) w.append(el('span', 'dt-avatars-more', `+${reviewers.length - 2}`));
    return w;
}
/** A person who is also the row's button: the circle, then the name as the one real button (Needs you: the agent). */
export function personButton(name, label) {
    const w = avatar(name);
    const b = primaryButton(name, label);
    w.querySelector('.dt-person-name')?.replaceWith(b);
    if (!w.querySelector('.dt-avatar')) w.append(b);
    return w;
}
/** A time as the app says it (relative), with the exact time on hover. */
export function timeCell(stamp) {
    const s = el('span', 'dt-time', whenText(stamp));
    if (stamp) s.title = new Date(stamp).toLocaleString();
    return s;
}
export function link(text, run) { return button('dt-link', text, run); }

/** Task completion: visible counts remain meaningful without colour or a filled bar. */
export function progressCell(done, total) {
    const cell = el('span', 'dt-progress');
    if (!total) { cell.textContent = 'No tasks yet'; return cell; }
    const label = `${done} of ${total} done`;
    const meter = el('progress', 'dt-progress-meter');
    meter.max = total; meter.value = done; meter.setAttribute('aria-label', label);
    cell.append(el('span', 'dt-progress-text', label), meter);
    return cell;
}

// ── the table ─────────────────────────────────────────────────────────────
const INTERACTIVE = 'a, input, select, textarea, summary, button:not(.dt-primary)';
const compareBy = (col) => {
    if (typeof col.sort === 'function') return col.sort;
    const val = col.sortValue || ((r) => (col.field != null ? r[col.field] : ''));
    return (a, b) => {
        const x = val(a), y = val(b);
        if (col.sort === 'number' || col.sort === 'date' || (typeof x === 'number' && typeof y === 'number')) { const nx = col.sort === 'date' ? Date.parse(x) || 0 : Number(x) || 0, ny = col.sort === 'date' ? Date.parse(y) || 0 : Number(y) || 0; return nx - ny; }
        return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    };
};

export function dataTable(cfg) {
    if (cfg.oneLine) cfg = { ...cfg, fold: 'none', layout: 'fixed', resize: false };
    const st = cfg.state || tableState();
    const columns = cfg.columns, sel = cfg.selectable || null, ctx = cfg.ctx || {};
    const foldKind = cfg.oneLine ? 'none' : cfg.fold || 'column', foldAt = cfg.foldAt || 40;
    if (sel && sel.contextKey !== undefined && st.ctx !== String(sel.contextKey)) { st.selected.clear(); st.rowCache?.clear(); st.confirming = -1; st.choices = null; st.anchor = null; st.ctx = String(sel.contextKey); }
    const hasContent = cfg.columns.some(c => c.width === 'content');
    const box = el('div', `dt-box${cfg.compact ? ' dt-compact' : ''}${foldAt === 'fit' ? ' dt-fit' : ''}${hasContent ? ' dt-has-content' : ''}${cfg.bare ? ' dt-bare' : ''}${cfg.scroll ? ' dt-scroll' : ''} ${foldKind === 'labeled' ? 'dt-fold-labeled' : foldKind === 'always' ? 'dt-fold-column' : foldKind === 'none' ? 'dt-fold-none' : 'dt-fold-column'}`);
    if (cfg.oneLine) box.classList.add('dt-one-line');
    const bar = el('div', 'dt-bar'); bar.hidden = true;
    const selectButton = button('btn btn-small dt-select-toggle', 'Select', () => { st.select = !st.select; syncSelectMode(); });
    selectButton.setAttribute('aria-pressed', 'false'); selectButton.hidden = !sel;
    let rows = cfg.rows.slice();
    const keyOf = (r) => String(cfg.rowKey(r));
    const eligible = r => !sel?.canSelect || sel.canSelect(r);
    st.rowCache ||= new Map();
    for (const r of rows) { if (eligible(r)) st.rowCache.set(keyOf(r), r); else { st.selected.delete(keyOf(r)); st.rowCache.delete(keyOf(r)); } }
    const nameOf = (r) => (cfg.rowName ? cfg.rowName(r) : keyOf(r));

    const sortBar = el('div', 'dt-sortbar');
    if (cfg.sortBar === false) sortBar.hidden = true; // a narrow column of a few rows (a goal's tasks) needs no Sort by
    const table = el('table', 'dt-table'); table.setAttribute('aria-label', cfg.label); table.setAttribute('role', 'table');
    if (cfg.layout === 'fixed' || cfg.oneLine) table.style.tableLayout = 'fixed'; // grouped lists share column widths even when their contents differ
    const thead = el('thead'); thead.setAttribute('role', 'rowgroup'); const tbody = el('tbody'); tbody.setAttribute('role', 'rowgroup');
    const colgroup = el('colgroup');
    table.append(colgroup, thead, tbody);
    const widthBar = el('div', 'dt-widthbar'); widthBar.hidden = true;
    const resetWidths = button('btn btn-small dt-reset-widths', 'Reset column widths', () => { st.widths = {}; saveWidths(); applyWidths(); drawHead(); });
    widthBar.append(resetWidths);
    box.append(sortBar, widthBar, table);

    // ── column widths (#7949): a handle on each header's right edge; the widths are kept per list in this browser ──
    const MIN_W = 64, MAX_W = 2000, STEP = 16;
    const wkey = `coral-dt-widths:${cfg.widthsKey || String(cfg.label).replace(/,\s*\d.*$/, '')}`; // a label that counts its rows ("Tasks, 12") is the list "Tasks"
    const minOf = (c) => c.minWidth || MIN_W;
    function readWidths() {
        try {
            const o = JSON.parse(browserLocal.get(wkey) || 'null') || {}, out = {};
            for (const c of columns) { const v = Number(o[c.key]); if (Number.isFinite(v) && v >= minOf(c) && v <= MAX_W) out[c.key] = Math.round(v); }
            return out;
        } catch { return {}; }
    }
    function saveWidths() {
        if (Object.keys(st.widths).length) browserLocal.set(wkey, JSON.stringify(st.widths)); else browserLocal.remove(wkey); // a convenience: the store is guarded, and the widths last until the page closes without it
    }
    st.widths ||= cfg.oneLine ? {} : readWidths();
    function applyWidths() {
        colgroup.replaceChildren();
        const any = Object.keys(st.widths).length > 0;
        box.classList.toggle('dt-sized', any); widthBar.hidden = !any;
        if (cfg.layout !== 'fixed' && !cfg.oneLine) table.style.tableLayout = any ? 'fixed' : '';
        if (!any) return;
        if (sel) { const k = el('col'); k.style.width = 'var(--table-check-w)'; colgroup.append(k); }
        for (const c of columns) { const k = el('col'); if (st.widths[c.key]) k.style.width = `${st.widths[c.key]}px`; colgroup.append(k); }
    }
    /** The first resize freezes the other columns at the widths they have (the title column, 'grow', takes whatever is left) so nothing jumps. */
    function freezeWidths() {
        for (const th of thead.querySelectorAll('th.dt-th')) { const c = columns.find(x => x.key === th.dataset.key); if (c && c.width !== 'grow' && !st.widths[c.key]) st.widths[c.key] = Math.max(minOf(c), Math.round(th.getBoundingClientRect().width)); }
    }
    function setWidth(c, w, th) {
        st.widths[c.key] = Math.min(MAX_W, Math.max(minOf(c), Math.round(w)));
        applyWidths();
        const h = th && th.querySelector('.dt-resize'); if (h) h.setAttribute('aria-valuenow', String(st.widths[c.key]));
    }
    /** The width the column needs for its widest cell and its head: the table is laid out at its natural width for a moment (auto layout, as wide as its content, none of the kept widths) and the column's own head is measured. */
    function fitWidth(c, th) {
        const was = { layout: table.style.tableLayout, width: table.style.width, cols: colgroup.cloneNode(true) };
        colgroup.replaceChildren(); table.style.tableLayout = 'auto'; table.style.width = 'max-content'; box.classList.remove('dt-sized');
        const natural = Math.ceil(th.getBoundingClientRect().width);
        table.style.tableLayout = was.layout; table.style.width = was.width; colgroup.replaceChildren(...was.cols.childNodes); box.classList.toggle('dt-sized', Object.keys(st.widths).length > 0);
        return Math.min(800, natural);
    }
    /** Fit the column to its content: when that is the width it has, nothing changed and nothing is kept (no Reset appears for it). */
    function fitTo(c, th) {
        const w = fitWidth(c, th);
        if (Math.abs(w - Math.round(th.getBoundingClientRect().width)) <= 1) return;
        freezeWidths(); setWidth(c, w, th); saveWidths();
    }
    function resizeHandle(c, th) {
        const h = el('span', 'dt-resize'); h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical'); h.tabIndex = 0; h.dataset.key = c.key;
        h.setAttribute('aria-label', `Resize ${c.label} column`); h.setAttribute('aria-valuemin', String(minOf(c))); h.setAttribute('aria-valuemax', String(MAX_W));
        const now = () => st.widths[c.key] || Math.round(th.getBoundingClientRect().width);
        h.setAttribute('aria-valuenow', String(now()));
        h.addEventListener('click', (e) => e.stopPropagation()); // a drag, or a press on the handle, never sorts
        h.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            h.setPointerCapture(e.pointerId); h.classList.add('dt-resizing');
            const startX = e.clientX, start = now(); let moved = false;
            const move = (ev) => { if (!moved) { if (Math.abs(ev.clientX - startX) < 2) return; moved = true; freezeWidths(); } setWidth(c, start + (ev.clientX - startX), th); }; // a press that does not move changes nothing: no frozen widths, no Reset
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); h.classList.remove('dt-resizing'); if (moved) saveWidths(); };
            h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
        });
        h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }); // fit the column to its content
        h.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? STEP * 3 : STEP;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); freezeWidths(); setWidth(c, now() + (e.key === 'ArrowRight' ? step : -step), th); saveWidths(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }
        });
        return h;
    }

    const sortable = columns.filter(c => c.sort);
    const sortedRows = () => {
        const s = st.sort && columns.find(c => c.key === st.sort.key);
        if (!s || !s.sort || cfg.onSort) return rows;
        const cmp = compareBy(s), dir = st.sort.dir === 'desc' ? -1 : 1;
        return rows.slice().sort((a, b) => dir * cmp(a, b));
    };

    function drawHead() {
        thead.replaceChildren();
        const tr = el('tr'); tr.setAttribute('role', 'row');
        if (sel) { const th = el('th', 'dt-check'); th.setAttribute('role', 'columnheader'); const all = el('input'); all.type = 'checkbox'; all.className = 'dt-check-all'; all.setAttribute('aria-label', 'Select all rows on this page'); all.addEventListener('change', () => { for (const r of rows.filter(eligible)) (all.checked ? st.selected.add(keyOf(r)) : st.selected.delete(keyOf(r))); st.anchor = null; syncSelection(); }); th.append(all); tr.append(th); }
        for (const c of columns) {
            const th = el('th', `dt-th${c.numeric || c.align === 'end' ? ' dt-end' : ''}`); th.scope = 'col'; th.setAttribute('role', 'columnheader'); th.dataset.key = c.key;
            if (cfg.oneLine && c.dropAt) th.setAttribute('data-drop-at', String(c.dropAt));
            if (c.width && /rem$/.test(c.width)) th.style.width = c.width;
            if (c.width === 'grow') th.classList.add('dt-grow');
            if (c.width === 'content') th.classList.add('dt-content');
            if (c.narrowHide) th.classList.add('dt-narrow-hide');
            if (c.sort) {
                const on = st.sort && st.sort.key === c.key;
                th.setAttribute('aria-sort', on ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
                const b = button('dt-sort', null, () => sortBy(c)); b.dataset.key = c.key; b.setAttribute('aria-label', `${c.label}, ${cfg.label}`); // named for its column and its table: "Cost" is not six buttons that read the same (#6432)
                b.append(el('span', null, c.label), el('span', 'dt-arrow', on ? (st.sort.dir === 'desc' ? '↓' : '↑') : '↕')); b.lastChild.setAttribute('aria-hidden', 'true');
                th.append(b);
            } else th.append(el('span', c.hideLabel ? 'sr-only' : 'dt-head-text', c.label)); // hideLabel: a column that is only an action has no head text on screen, its name is for a reader
            if (c.filter) { // a column the rows are narrowed by: filter = { label, active() -> bool, open(button) }; the surface owns the choice list, the header owns the button
                const f = button(`dt-filter${c.filter.active() ? ' dt-filter-on' : ''}`, null, (e) => { e.stopPropagation(); c.filter.open(f); });
                f.setAttribute('aria-label', c.filter.label); f.title = 'Filter';
                const icon = el('span', 'material-icons', 'filter_list'); icon.setAttribute('aria-hidden', 'true'); f.append(icon);
                th.append(f);
            }
            if (cfg.resize !== false && c.resize !== false) th.append(resizeHandle(c, th));
            if (cfg.decorateHead) cfg.decorateHead(th, c);
            tr.append(th);
        }
        thead.append(tr);
        drawSortBar();
    }

    function drawSortBar() {
        sortBar.replaceChildren();
        if (!sortable.length) { sortBar.hidden = true; return; } // nothing to sort by (a list in its own order, the chats): no empty bar above the rows
        const id = `dt-sort-${Math.random().toString(36).slice(2, 8)}`;
        const label = el('label', 'dt-sortbar-label', 'Sort by'); label.htmlFor = id;
        const select = el('select', 'dt-sortbar-select'); select.id = id;
        if (!st.sort && cfg.defaultSortLabel) { const o = el('option', null, cfg.defaultSortLabel); o.value = ''; o.disabled = true; select.append(o); }
        for (const c of sortable) { const o = el('option', null, c.label); o.value = c.key; select.append(o); }
        select.value = (st.sort && st.sort.key) || (cfg.defaultSortLabel ? '' : sortable[0].key);
        select.addEventListener('change', () => { const c = columns.find(x => x.key === select.value); st.sort = null; sortBy(c, true); });
        const dir = button('btn dt-sortbar-dir', st.sort && st.sort.dir === 'desc' ? 'Descending' : 'Ascending', () => { const c = columns.find(x => x.key === select.value); sortBy(c); });
        dir.hidden = !st.sort && !!cfg.defaultSortLabel;
        sortBar.append(label, select, dir);
    }

    function sortBy(c, keepDir) {
        const same = st.sort && st.sort.key === c.key;
        st.sort = { key: c.key, dir: same && !keepDir ? (st.sort.dir === 'asc' ? 'desc' : 'asc') : (same ? st.sort.dir : (c.firstDir || 'asc')) };
        if (cfg.onSort) { cfg.onSort(st.sort.key, st.sort.dir); return; }
        const held = document.activeElement && document.activeElement.classList.contains('dt-sort') ? document.activeElement.dataset.key : '';
        drawHead(); drawBody();
        if (held) thead.querySelector(`.dt-sort[data-key="${CSS.escape(held)}"]`)?.focus({ preventScroll: true });
    }

    function cellOf(c, r, tr) {
        const td = el('td', `dt-td dt-tone-${c.tone || (c.primary ? 'primary' : 'secondary')}${c.numeric || c.align === 'end' ? ' dt-end' : ''}${c.nowrap === false ? ' dt-wrap' : ''}`);
        if (c.width === 'grow') td.classList.add('dt-grow');
        if (c.width === 'content') td.classList.add('dt-content');
        td.setAttribute('role', 'cell'); td.dataset.label = c.label; td.dataset.key = c.key;
        if (cfg.oneLine && c.dropAt) td.setAttribute('data-drop-at', String(c.dropAt));
        td.classList.add(c.line === 1 ? 'dt-line-1' : c.line === 2 ? 'dt-line-2' : 'dt-line-0');
        if (c.when && !c.when(r)) td.classList.add('dt-when-off');
        if (c.foldFirst) td.classList.add('dt-fold-first');
        if (st.sort && st.sort.key === c.key) td.classList.add('dt-fold-key'); // folded 'labeled': the figure the rows are sorted by is the one stronger line (#7738)
        if (c.narrowHide) td.classList.add('dt-narrow-hide'); // folded 'labeled': this figure follows the name, ahead of the other "label value" lines
        let v = c.cell ? c.cell(r, ctx, { open: () => (cfg.open ? cfg.open(r, tr) : undefined), hasOpen: !!cfg.open }) : (c.field != null ? r[c.field] : ''); // a cell's third argument: { open(), hasOpen } is the row's own open, for a button in the cell that opens what the row opens
        if (typeof v === 'string' && c.primary) v = primaryButton(v, `Open ${v}`);
        if (v instanceof Node) td.append(v); else td.textContent = v == null ? '' : String(v);
        if (c.title) { const t = c.title(r); if (t) td.title = t; } // the full name or id on hover
        if (c.subtitle) { const s = c.subtitle(r); if (s) td.append(el('span', 'dt-subtitle', s)); }
        return td;
    }

    // detail (#7903): one more full-width row under each row, hidden until the surface says it is open; the toggle that opens it is a button in one of the row's cells (aria-expanded, aria-controls: the detail's id)
    function detailRow(r, k, cols) {
        const d = cfg.detail, tr = el('tr', 'dt-detail'); tr.setAttribute('role', 'row'); tr.dataset.detailFor = k;
        const id = d.id && d.id(r); if (id) tr.id = id;
        tr.hidden = !(d.open && d.open(r));
        const td = el('td', 'dt-detail-cell'); td.setAttribute('role', 'cell'); td.colSpan = cols;
        td.append(d.render(r));
        tr.append(td);
        return tr;
    }

    function drawBody() {
        tbody.replaceChildren();
        const list = sortedRows();
        const cols = columns.length + (sel ? 1 : 0);
        let lastGroup = null;
        list.forEach((r, i) => {
            if (cfg.groupBy && !st.sort) { // the rows come in the caller's order: a divider where their group changes (a day), none once the person has sorted
                const g = cfg.groupBy(r);
                if (g && g.key !== lastGroup) { lastGroup = g.key; const gr = el('tr', 'dt-group'); gr.setAttribute('role', 'row'); const gh = el('th', null, g.label); gh.colSpan = cols; gh.scope = 'rowgroup'; gh.setAttribute('role', 'rowheader'); gr.append(gh); tbody.append(gr); }
            }
            const k = keyOf(r), tr = el('tr', 'dt-row'); tr.setAttribute('role', 'row'); tr.dataset.key = k;
            if (cfg.quiet && cfg.quiet(r)) tr.classList.add('dt-quiet'); // a row that is not a finding (usage whose level was not recorded): quieter than the rest
            if (sel) {
                const td = el('td', 'dt-check'); td.setAttribute('role', 'cell');
                const cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', `Select ${nameOf(r)}`); cb.dataset.idx = String(i); cb.disabled = !eligible(r); if (cb.disabled) cb.hidden = true;
                cb.addEventListener('click', (e) => {
                    if (!eligible(r)) return;
                    const on = cb.checked;
                    if (e.shiftKey && st.anchor != null && st.anchor !== i) { const [a, b] = st.anchor < i ? [st.anchor, i] : [i, st.anchor]; for (let j = a; j <= b; j++) if (eligible(list[j])) (on ? st.selected.add(keyOf(list[j])) : st.selected.delete(keyOf(list[j]))); }
                    else (on ? st.selected.add(k) : st.selected.delete(k));
                    st.anchor = i; syncSelection();
                });
                td.append(cb); tr.append(td);
            }
            for (const c of columns) tr.append(cellOf(c, r, tr));
            if (cfg.open) {
                tr.classList.add('dt-row-open');
                tr.addEventListener('click', (e) => {
                    if (e.target.closest(INTERACTIVE)) return;
                    if (sel && box.classList.contains('dt-folded') && st.select) { const cb = tr.querySelector('.dt-check input'); if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey })); return; } // a click event on a checkbox toggles it itself
                    cfg.open(r, tr);
                });
            }
            if (cfg.current != null && cfg.current === k) tr.setAttribute('aria-current', 'true');
            tbody.append(tr);
            const dr = cfg.detail ? detailRow(r, k, cols) : null;
            if (dr) tbody.append(dr);
            if (cfg.decorate) cfg.decorate(r, tr, dr); // the surface's own hooks on a row it owns (an id, a class a deep link reads, a key handler): called again whenever the rows are drawn again, a sort included
        });
        syncSelection(true);
    }

    function syncSelection(quiet) {
        if (!sel) return;
        const present = new Set(rows.map(keyOf));
        for (const tr of tbody.querySelectorAll(':scope > .dt-row')) { const on = st.selected.has(tr.dataset.key); tr.classList.toggle('dt-selected', on); tr.setAttribute('aria-selected', String(on)); const cb = tr.querySelector('.dt-check input'); if (cb) cb.checked = on; }
        const all = thead.querySelector('.dt-check-all');
        if (all) { const available = rows.filter(eligible), n = available.filter(r => st.selected.has(keyOf(r))).length; all.disabled = !available.length; all.checked = n > 0 && n === available.length; all.indeterminate = n > 0 && n < available.length; }
        drawBar();
        if (!quiet && sel.onChange) sel.onChange(new Set(st.selected));
        void present;
    }

    function drawBar() {
        const n = st.selected.size;
        bar.hidden = n === 0; bar.replaceChildren();
        if (!n) { st.confirming = -1; st.choices = null; return; }
        bar.append(el('span', 'dt-bar-count', `${n} selected`));
        const actions = sel.actions || [];
        const chosen = () => [...st.selected].map(k => st.rowCache.get(k)).filter(Boolean);
        actions.forEach((a, i) => {
            if (st.confirming >= 0) return; // while one asks, the others wait
            const action = button(`btn btn-small dt-bar-action${a.danger ? ' dt-danger' : ''}`, a.label, async () => {
                if (a.choose) { st.choices = await a.choose.options(); st.confirming = i; drawBar(); bar.querySelector(a.danger ? '.dt-bar-keep' : '.dt-bar-choice')?.focus(); return; } // an action that needs a value (a person, a priority) asks for it here
                if (a.danger) { st.confirming = i; drawBar(); bar.querySelector('.dt-bar-keep')?.focus(); return; }
                a.run(chosen(), new Set(st.selected));
            });
            action.disabled = !!a.disabled?.(chosen()); bar.append(action);
        });
        if (st.confirming >= 0) {
            const a = actions[st.confirming];
            if (a.choose) {
                const pick = el('select', 'dt-bar-choice'); pick.setAttribute('aria-label', a.choose.label);
                for (const o of st.choices || []) { const op = el('option', null, o.label); op.value = o.value; pick.append(op); }
                const text = a.choose.text ? el('input', 'dt-bar-text') : null;
                if (text) { text.type = 'text'; text.setAttribute('aria-label', a.choose.text.label); text.placeholder = a.choose.text.label; text.maxLength = a.choose.text.maxLength || 300; text.required = true; }
                const apply = button(`btn btn-small dt-bar-apply${a.danger ? ' dt-danger' : ''}`, a.danger ? a.label : 'Apply', () => { if (text && !text.value.trim()) { text.reportValidity(); return; } const v = pick.value; st.confirming = -1; st.choices = null; a.run(chosen(), new Set(st.selected), v, text?.value.trim()); });
                if (text) { apply.disabled = true; text.addEventListener('input', () => { apply.disabled = !text.value.trim(); }); }
                const ask = typeof a.confirm === 'function' ? a.confirm(n) : a.confirm || `${a.label}:`;
                const step = el('div', 'dt-bar-step');
                step.append(el('span', 'dt-bar-confirm', ask), pick); if (text) step.append(text);
                step.append(button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; st.choices = null; drawBar(); }), apply);
                bar.append(step);
            } else {
                const ask = el('span', 'dt-bar-confirm', typeof a.confirm === 'function' ? a.confirm(n) : (a.confirm || `${a.label}?`)); ask.setAttribute('role', 'alert');
                bar.append(ask, button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; drawBar(); }), button('btn btn-small dt-danger', a.label, () => { st.confirming = -1; a.run(chosen(), new Set(st.selected)); }));
            }
        }
        bar.append(button('btn btn-small dt-bar-clear', 'Clear', () => clear()));
    }

    function clear() { st.selected.clear(); st.anchor = null; st.confirming = -1; st.choices = null; syncSelection(); }
    function syncSelectMode() { box.classList.toggle('dt-selecting', st.select); selectButton.textContent = st.select ? 'Done' : 'Select'; selectButton.setAttribute('aria-pressed', String(st.select)); }

    drawHead(); drawBody(); syncSelectMode(); applyWidths();
    if (!rows.length && cfg.empty) {
        const e = el('div', 'empty-state'); e.append(el('p', 'empty-state-line', cfg.empty.line));
        if (cfg.empty.hint) e.append(el('p', 'empty-state-hint', cfg.empty.hint));
        if (cfg.empty.action) e.append(button('btn', cfg.empty.action.label, cfg.empty.action.run));
        box.replaceChildren(e);
    } else if (cfg.footer && !(cfg.footer.auto && !cfg.footer.more)) { // footer.auto (#7937): a count line that says all rows are shown says nothing, so with nothing more to load the footer is not drawn
        const foot = el('div', 'dt-foot'); foot.append(el('span', 'dt-foot-text', cfg.footer.text || ''));
        if (cfg.footer.more) {
            const m = button('btn dt-more', cfg.footer.more.busy ? 'Loading…' : cfg.footer.more.label, cfg.footer.more.run); if (cfg.footer.more.busy) m.setAttribute('aria-busy', 'true'); foot.append(m);
            // footer.auto: more rows come when the footer scrolls into view (a long list that is read, not paged by hand); the button stays for the keyboard
            if (cfg.footer.auto && !cfg.footer.more.busy && typeof IntersectionObserver === 'function') { const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); cfg.footer.more.run(); } }, { rootMargin: '300px' }); io.observe(foot); }
        }
        box.append(foot);
    }

    // before the box has a width (it is built apart from the page) a window narrower than THIS table's fold starts it folded: a first paint of the wide table would scroll the page sideways (#7868). Only that window: one that is wider
    // than the fold (a 481-760 px one among them) is left unfolded, or the observer below would unfold it a frame later, a flash (#7994). A box that already has a width is judged by it. The observer then settles every case.
    if (cfg.fold !== 'none') { const root0 = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; const known = box.clientWidth; if (cfg.fold === 'always' || (known ? known : window.innerWidth) < foldAt * root0) box.classList.add('dt-folded'); }
    // folded: the table's own box narrower than foldAt rem (the root font size is read, so a larger text size folds sooner); set before the first paint
    if (cfg.fold !== 'none' && typeof ResizeObserver === 'function') {
        const root = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const syncFold = () => {
            const w = box.clientWidth; if (!w) return;
            let on = cfg.fold === 'always' || w < foldAt * root();
            if (foldAt === 'fit' && cfg.fold !== 'always') {
                // Measure the actual table in its available width, before paint. Names may
                // ellipsize; headers and metadata must fit without clipping or sideways scroll.
                box.classList.remove('dt-folded');
                on = table.getBoundingClientRect().width > w + 1;
            }
            box.classList.toggle('dt-folded', on);
        };
        new ResizeObserver(syncFold).observe(box);
        document.fonts?.ready.then(syncFold);
    }
    return { el: box, bar, selectButton, selection: () => new Set(st.selected), clear, state: st };
}
