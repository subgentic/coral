/* The one table (#7743): every list or table surface passes what to show, the component owns how it looks and behaves. The operator's rule: a styling change is one token or one rule, so every size and colour here
 * is a --table-* token (css/data_table.css) and no surface styles a row, a cell or a header.
 *
 *   dataTable({ label, columns, rows, rowKey, open, current, state, onSort, fold, foldAt, sortBar, bare, empty, footer, selectable, rowName }) -> { el, bar, selectButton, selection(), clear(), state }
 *   selectable = { contextKey, onChange(keys), actions: [{ label, run(rows, keys, value), danger, confirm, choose: { label, options() -> [{ value, label }] } }] }: a danger action confirms in the bar, a choose action asks for its value there.
 *   Column = { key, label, field | cell(row, ctx), primary, tone: 'primary'|'secondary'|'tertiary', width: 'grow'|'content'|'<n>rem', nowrap, align: 'start'|'end', numeric,
 *              sort: true|'number'|'date'|fn(a, b), sortValue(row), line: 0|1|2, when(row), subtitle(row) }
 *   cell types: chip(word, cls), avatar(name), tag(text), timeCell(stamp), link(text, run), primaryButton(text, label)
 *   state: tableState(), kept by the caller across redraws: the sort, and the selection (a set of row keys, kept while the rows are filtered or paged, cleared when selectable.contextKey changes).
 * Folded (the table's own box narrower than foldAt rem, 40 by default; also at 200% text): fold 'column' is the two-line row (line 1 and line 2 cells), fold 'labeled' is the name, then "label value" lines
 * (the Analytics tables); the header row is hidden and a "Sort by" select takes its place. Everything is built with the DOM and textContent: titles and names are written by agents. */
import { whenText } from './when_text.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

export const tableState = () => ({ sort: null, selected: new Set(), anchor: null, ctx: undefined, select: false, confirming: -1 });

// ── cell types ────────────────────────────────────────────────────────────
/** The row's one real button: its text names the row. */
export function primaryButton(text, label) {
    const b = el('button', 'dt-primary', text); b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
}
/** A state as a dot and a word (the dot is decoration: the word says it). */
export function chip(word, cls) {
    const c = el('span', `dt-chip goal-chip ${cls || ''}`.trim());
    c.append(el('span', 'goal-dot'), document.createTextNode(word));
    return c;
}
export function tag(text) { return el('span', 'dt-tag', text); }
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
/** A time as the app says it (relative), with the exact time on hover. */
export function timeCell(stamp) {
    const s = el('span', 'dt-time', whenText(stamp));
    if (stamp) s.title = new Date(stamp).toLocaleString();
    return s;
}
export function link(text, run) { return button('dt-link', text, run); }

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
    const st = cfg.state || tableState();
    const columns = cfg.columns, sel = cfg.selectable || null, ctx = cfg.ctx || {};
    const foldKind = cfg.fold || 'column', foldAt = cfg.foldAt || 40;
    if (sel && sel.contextKey !== undefined && st.ctx !== String(sel.contextKey)) { st.selected.clear(); st.anchor = null; st.ctx = String(sel.contextKey); }
    const box = el('div', `dt-box${cfg.bare ? ' dt-bare' : ''} ${foldKind === 'labeled' ? 'dt-fold-labeled' : foldKind === 'always' ? 'dt-fold-column' : foldKind === 'none' ? 'dt-fold-none' : 'dt-fold-column'}`);
    const bar = el('div', 'dt-bar'); bar.hidden = true;
    const selectButton = button('btn btn-small dt-select-toggle', 'Select', () => { st.select = !st.select; syncSelectMode(); });
    selectButton.setAttribute('aria-pressed', 'false'); selectButton.hidden = !sel;
    let rows = cfg.rows.slice();
    const keyOf = (r) => String(cfg.rowKey(r));
    const nameOf = (r) => (cfg.rowName ? cfg.rowName(r) : keyOf(r));

    const sortBar = el('div', 'dt-sortbar');
    if (cfg.sortBar === false) sortBar.hidden = true; // a narrow column of a few rows (a goal's tasks) needs no Sort by
    const table = el('table', 'dt-table'); table.setAttribute('aria-label', cfg.label); table.setAttribute('role', 'table');
    const thead = el('thead'); thead.setAttribute('role', 'rowgroup'); const tbody = el('tbody'); tbody.setAttribute('role', 'rowgroup');
    table.append(thead, tbody);
    box.append(sortBar, table);

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
        if (sel) { const th = el('th', 'dt-check'); th.setAttribute('role', 'columnheader'); const all = el('input'); all.type = 'checkbox'; all.className = 'dt-check-all'; all.setAttribute('aria-label', 'Select all rows on this page'); all.addEventListener('change', () => { for (const r of rows) (all.checked ? st.selected.add(keyOf(r)) : st.selected.delete(keyOf(r))); st.anchor = null; syncSelection(); }); th.append(all); tr.append(th); }
        for (const c of columns) {
            const th = el('th', `dt-th${c.numeric || c.align === 'end' ? ' dt-end' : ''}`); th.scope = 'col'; th.setAttribute('role', 'columnheader'); th.dataset.key = c.key;
            if (c.width && /rem$/.test(c.width)) th.style.width = c.width;
            if (c.width === 'grow') th.classList.add('dt-grow');
            if (c.sort) {
                const on = st.sort && st.sort.key === c.key;
                th.setAttribute('aria-sort', on ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
                const b = button('dt-sort', null, () => sortBy(c)); b.dataset.key = c.key;
                b.append(el('span', null, c.label), el('span', 'dt-arrow', on ? (st.sort.dir === 'desc' ? '↓' : '↑') : '↕')); b.lastChild.setAttribute('aria-hidden', 'true');
                th.append(b);
            } else th.append(el('span', 'dt-head-text', c.label));
            tr.append(th);
        }
        thead.append(tr);
        drawSortBar();
    }

    function drawSortBar() {
        sortBar.replaceChildren();
        if (!sortable.length) return;
        const id = `dt-sort-${Math.random().toString(36).slice(2, 8)}`;
        const label = el('label', 'dt-sortbar-label', 'Sort by'); label.htmlFor = id;
        const select = el('select', 'dt-sortbar-select'); select.id = id;
        for (const c of sortable) { const o = el('option', null, c.label); o.value = c.key; select.append(o); }
        select.value = (st.sort && st.sort.key) || sortable[0].key;
        select.addEventListener('change', () => { const c = columns.find(x => x.key === select.value); st.sort = null; sortBy(c, true); });
        const dir = button('btn dt-sortbar-dir', st.sort && st.sort.dir === 'desc' ? 'Descending' : 'Ascending', () => { const c = columns.find(x => x.key === select.value); sortBy(c); });
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

    function cellOf(c, r) {
        const td = el('td', `dt-td dt-tone-${c.tone || (c.primary ? 'primary' : 'secondary')}${c.numeric || c.align === 'end' ? ' dt-end' : ''}${c.nowrap === false ? ' dt-wrap' : ''}`);
        if (c.width === 'grow') td.classList.add('dt-grow');
        td.setAttribute('role', 'cell'); td.dataset.label = c.label; td.dataset.key = c.key;
        td.classList.add(c.line === 1 ? 'dt-line-1' : c.line === 2 ? 'dt-line-2' : 'dt-line-0');
        if (c.when && !c.when(r)) td.classList.add('dt-when-off');
        let v = c.cell ? c.cell(r, ctx) : (c.field != null ? r[c.field] : '');
        if (typeof v === 'string' && c.primary) v = primaryButton(v, `Open ${v}`);
        if (v instanceof Node) td.append(v); else td.textContent = v == null ? '' : String(v);
        if (c.subtitle) { const s = c.subtitle(r); if (s) td.append(el('span', 'dt-subtitle', s)); }
        return td;
    }

    function drawBody() {
        tbody.replaceChildren();
        const list = sortedRows();
        list.forEach((r, i) => {
            const k = keyOf(r), tr = el('tr', 'dt-row'); tr.setAttribute('role', 'row'); tr.dataset.key = k;
            if (sel) {
                const td = el('td', 'dt-check'); td.setAttribute('role', 'cell');
                const cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', `Select ${nameOf(r)}`); cb.dataset.idx = String(i);
                cb.addEventListener('click', (e) => {
                    const on = cb.checked;
                    if (e.shiftKey && st.anchor != null && st.anchor !== i) { const [a, b] = st.anchor < i ? [st.anchor, i] : [i, st.anchor]; for (let j = a; j <= b; j++) (on ? st.selected.add(keyOf(list[j])) : st.selected.delete(keyOf(list[j]))); }
                    else (on ? st.selected.add(k) : st.selected.delete(k));
                    st.anchor = i; syncSelection();
                });
                td.append(cb); tr.append(td);
            }
            for (const c of columns) tr.append(cellOf(c, r));
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
        });
        syncSelection(true);
    }

    function syncSelection(quiet) {
        if (!sel) return;
        const present = new Set(rows.map(keyOf));
        for (const tr of tbody.children) { const on = st.selected.has(tr.dataset.key); tr.classList.toggle('dt-selected', on); tr.setAttribute('aria-selected', String(on)); const cb = tr.querySelector('.dt-check input'); if (cb) cb.checked = on; }
        const all = thead.querySelector('.dt-check-all');
        if (all) { const n = rows.filter(r => st.selected.has(keyOf(r))).length; all.checked = n > 0 && n === rows.length; all.indeterminate = n > 0 && n < rows.length; }
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
        const chosen = () => rows.filter(r => st.selected.has(keyOf(r)));
        actions.forEach((a, i) => {
            if (st.confirming >= 0) return; // while one asks, the others wait
            bar.append(button(`btn btn-small dt-bar-action${a.danger ? ' dt-danger' : ''}`, a.label, async () => {
                if (a.choose) { st.choices = await a.choose.options(); st.confirming = i; drawBar(); bar.querySelector('.dt-bar-choice')?.focus(); return; } // an action that needs a value (a person, a priority) asks for it here
                if (a.danger) { st.confirming = i; drawBar(); bar.querySelector('.dt-bar-keep')?.focus(); return; }
                a.run(chosen(), new Set(st.selected));
            }));
        });
        if (st.confirming >= 0) {
            const a = actions[st.confirming];
            if (a.choose) {
                const pick = el('select', 'dt-bar-choice'); pick.setAttribute('aria-label', a.choose.label);
                for (const o of st.choices || []) { const op = el('option', null, o.label); op.value = o.value; pick.append(op); }
                bar.append(el('span', 'dt-bar-confirm', `${a.label}:`), pick, button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; st.choices = null; drawBar(); }), button('btn btn-small dt-bar-apply', 'Apply', () => { const v = pick.value; st.confirming = -1; st.choices = null; a.run(chosen(), new Set(st.selected), v); }));
            } else {
                const ask = el('span', 'dt-bar-confirm', typeof a.confirm === 'function' ? a.confirm(n) : (a.confirm || `${a.label}?`)); ask.setAttribute('role', 'alert');
                bar.append(ask, button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; drawBar(); }), button('btn btn-small dt-danger', a.label, () => { st.confirming = -1; a.run(chosen(), new Set(st.selected)); }));
            }
        }
        bar.append(button('btn btn-small dt-bar-clear', 'Clear', () => clear()));
    }

    function clear() { st.selected.clear(); st.anchor = null; st.confirming = -1; st.choices = null; syncSelection(); }
    function syncSelectMode() { box.classList.toggle('dt-selecting', st.select); selectButton.textContent = st.select ? 'Done' : 'Select'; selectButton.setAttribute('aria-pressed', String(st.select)); }

    drawHead(); drawBody(); syncSelectMode();
    if (!rows.length && cfg.empty) {
        const e = el('div', 'dt-empty'); e.append(el('p', 'dt-empty-line', cfg.empty.line));
        if (cfg.empty.hint) e.append(el('p', 'dt-empty-hint', cfg.empty.hint));
        if (cfg.empty.action) e.append(button('btn', cfg.empty.action.label, cfg.empty.action.run));
        box.replaceChildren(e);
    } else if (cfg.footer) {
        const foot = el('div', 'dt-foot'); foot.append(el('span', 'dt-foot-text', cfg.footer.text || ''));
        if (cfg.footer.more) { const m = button('btn dt-more', cfg.footer.more.busy ? 'Loading…' : cfg.footer.more.label, cfg.footer.more.run); if (cfg.footer.more.busy) m.setAttribute('aria-busy', 'true'); foot.append(m); }
        box.append(foot);
    }

    // folded: the table's own box narrower than foldAt rem (the root font size is read, so a larger text size folds sooner); set before the first paint
    if (cfg.fold !== 'none' && typeof ResizeObserver === 'function') {
        const root = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        new ResizeObserver(() => { const w = box.clientWidth; if (!w) return; const on = cfg.fold === 'always' || w < foldAt * root(); box.classList.toggle('dt-folded', on); }).observe(box);
    }
    return { el: box, bar, selectButton, selection: () => new Set(st.selected), clear, state: st };
}
