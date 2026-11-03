/* Table sizing and resize interactions, loaded when a table needs them, not in app.js. */
import { browserLocal } from './safe_storage.js';
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';
import { loadStyles } from './lazy_styles.js';
export function createColumnSizing({ cfg, st, columns, sel, box, table, thead, colgroup, mailOn, hiddenBar, hiddenBtn, hiddenMenu, resetBtn, closeHidden, el, button, attrEsc, getEmptyKeys }) {
    // ── column widths (#7949): a handle on each header's right edge; the widths are kept per list in this browser ──
    const MIN_W = 64, MAX_W = 2000, STEP = 16;
    const wkey = `coral-dt-widths:${cfg.widthsKey || String(cfg.label).replace(/,\s*\d.*$/, '')}`; // a label that counts its rows ("Tasks, 12") is the list "Tasks"
    const headNeed = (c) => { const th = thead.querySelector(`th.dt-th[data-key="${c.key}"]`), t = th && th.querySelector('.dt-sort > span, .dt-head-text'); if (!t || !th.getClientRects().length) return 0; const cs = getComputedStyle(th); return Math.ceil(t.getBoundingClientRect().width + (c.sort ? 20 : 0) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)); }; // the width its whole head needs: the label, the sort arrow and the cell's padding (#11835: Blocks was cut to "Bl")
    const minOf = (c) => Math.max(c.minWidth || MIN_W, headNeed(c));
    const wOf = (c) => (st.widths[c.key] ? Math.max(st.widths[c.key], minOf(c)) : 0);
    const ITEM_MIN = 120; // the name column is the one that gives room: it truncates down to this
    const fixedW = (c) => (c.fixed && /rem$/.test(c.width || '') ? c.width : null); // a fixed column (the Actions of a list) has the width it declares: no handle, never frozen or kept, so no other column's resize squeezes its buttons (#9845)
    const elasticColumn = cols => cols.find(c => c.width === 'grow') || cols.find(c => c.primary) || cols.find(c => !fixedW(c) && !c.fixed);
    function readWidths() {
        try {
            const o = JSON.parse(browserLocal.get(wkey) || 'null') || {}, out = {};
            for (const c of columns) { const v = Number(o[c.key]); if (!c.fixed && c !== elasticColumn(columns) && Number.isFinite(v) && v >= minOf(c) && v <= MAX_W) out[c.key] = Math.round(v); } // a fixed column is never kept
            return out;
        } catch { return {}; }
    }
    function saveWidths() {
        if (Object.keys(st.widths).length) browserLocal.set(wkey, JSON.stringify(st.widths)); else browserLocal.remove(wkey); // a convenience: the store is guarded, and the widths last until the page closes without it
    }
    let tightKeys = new Set(); // the columns dropped because the box is narrow (applyWidths, below): their <col> is hidden too, or the widths of the colgroup shift onto the wrong columns (#10443)
    st.widths ||= cfg.oneLine && !cfg.resize ? {} : readWidths();
    const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    /** What the last resizable column takes: its own width, or what the others leave of the box. */
    function fillPx(c, shown) {
        const t = thead.querySelector('th.dt-check'), rest = (sel && t ? Math.round(t.getBoundingClientRect().width) : 0) + shown.filter(x => x !== c).reduce((n, x) => n + (wOf(x) || (fixedW(x) ? parseFloat(fixedW(x)) * remPx() : 0)), 0);
        return Math.max(wOf(c), Math.floor(box.clientWidth - rest));
    }
    /** Every column's width is decided here, in one place (#11943, the operator's table rules, design note 9ced561a): the table always fits its box; ONE column (the primary, or the one that grows) is elastic and takes what the others leave; a column is never narrower than its whole header; a kept width is fitted to the box it meets; Time and Actions (fixed, in rem) keep their width. The columns have the width their content needs (at most their own max), a kept width wins; when they do not fit, the optional ones go by priority (`drop`, lowest first), then the others are squeezed, last first, down to their header, and only then does the table scroll. A phone's folded rows are laid out by CSS: nothing here. */
    function syncHidden(dropped) {
        const gone = columns.filter(c => dropped.has(c.key));
        const kept = Object.keys(st.widths).length > 0;
        resetBtn.hidden = !kept; hiddenBtn.hidden = !gone.length; hiddenBar.hidden = !gone.length && !kept;
        if (!hiddenBar.hidden) loadStyles('data_table_hidden.css'); // the bar's rules come the first time a column is hidden or a width is kept, not at start
        if (!gone.length) { closeHidden(); return; }
        const word = `${gone.length} column${gone.length === 1 ? '' : 's'} hidden`; hiddenBtn.textContent = word; hiddenBtn.setAttribute('aria-label', `${word}: ${gone.map(c => c.label || c.key).join(', ')}. Show one`);
        hiddenMenu.replaceChildren(...gone.map(c => { const b = button('menu-item', `Show ${c.label || c.key}`, async e => { e.stopPropagation(); (st.pinned ||= new Set()).add(c.key); (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: true }); applyWidths(); }); b.setAttribute('role', 'menuitem'); return b; }));
    }
    let L0 = null; // the last layout: the box's width, what each column got and the room the elastic column has left (setWidth reads it)
    function measureNatural(live) { // the table is laid out at its natural width for a moment (auto layout, as wide as its content, none of the sizes below): each head is as wide as its widest cell, its own max or its head needs
        for (const n of box.querySelectorAll('.dt-col-tight')) n.classList.remove('dt-col-tight'); // every column is shown while it is measured: a hidden column measures 0 and the next layout would not drop it, then would (it flip-flopped)
        colgroup.replaceChildren(); table.style.tableLayout = 'auto'; table.style.width = 'max-content'; box.classList.remove('dt-sized'); box.style.removeProperty('--dt-sized-min'); box.classList.add('dt-measure'); // (the sizes of a laid-out table, --dt-sized-min among them, are off while it is measured, so the natural width is the same every time)
        const out = {};
        for (const c of live) { const th = thead.querySelector(`th.dt-th[data-key="${attrEsc(c.key)}"]`); out[c.key] = th && th.getClientRects().length ? Math.ceil(th.getBoundingClientRect().width) : 0; }
        box.classList.remove('dt-measure');
        return out;
    }
    const cssHides = (c) => (!!c.narrowHide && box.clientWidth <= 64 * remPx()) || (cfg.oneLine && c.dropAt && box.clientWidth <= c.dropAt * remPx()); // data_table.css hides a narrowHide column in a box of 64 rem or less: it has no cell then, so it takes no width (its <col> would shift every width after it onto the wrong column)
    function applyWidths() {
        if ((cfg.oneLine || cfg.layout === 'fixed') && cfg.resize !== true) return;
        if (mailOn() || box.classList.contains('dt-folded') || (cfg.oneLine && isPhoneLayout())) { // a folded (phone) row is laid out by CSS: what the unfolded table left on it goes, or the folded rows keep its pixel width (#11943)
            if (L0) { L0 = null; colgroup.replaceChildren(); table.style.tableLayout = ''; table.style.width = ''; box.classList.remove('dt-sized'); box.style.removeProperty('--dt-sized-min'); tightKeys = new Set(); for (const n of box.querySelectorAll('.dt-col-tight')) n.classList.remove('dt-col-tight'); syncHidden(new Set()); }
            return;
        }
        if (!box.clientWidth) return;
        const avail = box.clientWidth, rem = remPx(), live = columns.filter(c => !getEmptyKeys().has(c.key) && !cssHides(c)), prim = elasticColumn(live); // a table always has one elastic column: the one it declares, or else its first that is not fixed
        for (const n of box.querySelectorAll('.dt-grow-implied')) n.classList.remove('dt-grow', 'dt-grow-implied'); // the elastic column a table did not declare is marked like one it did (dt-grow), until the layout picks it again
        if (prim && prim.width !== 'grow' && !prim.primary) for (const n of box.querySelectorAll(`th.dt-th[data-key="${attrEsc(prim.key)}"], td.dt-td[data-key="${attrEsc(prim.key)}"]`)) if (!n.classList.contains('dt-grow')) n.classList.add('dt-grow', 'dt-grow-implied');
        const nat = measureNatural(live);
        const chkTh = sel ? thead.querySelector('th.dt-check') : null, chk = chkTh && chkTh.getClientRects().length ? Math.round(chkTh.getBoundingClientRect().width) : 0;
        // the flexible columns: the elastic one (the primary, or the one that grows) and the others that declare a share; they split what the fixed-size columns leave, by their shares, none below its floor
        const flex = live.filter(c => c === prim || c.share), isFlex = c => flex.includes(c), w = {};
        const probe = el('span'); probe.style.cssText = 'position:absolute;visibility:hidden;width:100ch'; box.append(probe); const chPx = probe.getBoundingClientRect().width / 100; probe.remove(); // one character's width here
        const charsOf = c => (c.min ? Math.min(Math.round(c.min * chPx), Math.round(avail * 0.4)) : 0); // the room a column declares in characters (never more than 40% of the box)
        const hardOf = c => Math.max(ITEM_MIN, minOf(c)), pref = {}, base = {};
        const baseOf = c => (c === prim ? Math.max(hardOf(c), charsOf(c)) : Math.max(minOf(c), 96, charsOf(c))); // what a flexible column keeps at least (the name: 120 px, or its characters): no kept width in it, so what drops does not depend on a drag
        const natW = c => (fixedW(c) || (cfg.oneLine && /rem$/.test(c.width || '')) ? Math.round(parseFloat(c.width) * rem) : Math.min(MAX_W, Math.max(minOf(c), nat[c.key] || 0)));
        for (const c of live) { if (!isFlex(c)) w[c.key] = natW(c); }
        let active = live.slice(); const dropped = new Set();
        for (const c of flex) { base[c.key] = baseOf(c); if (c === prim) pref[c.key] = base[c.key]; }
        const total = () => chk + active.reduce((n, c) => n + (isFlex(c) ? base[c.key] : w[c.key]), 0);
        const squeezeOthers = () => { let over = total() - avail; for (const c of [...active].reverse()) { if (over <= 0) break; if (isFlex(c) || fixedW(c)) continue; const give = Math.min(over, w[c.key] - minOf(c)); if (give > 0) { w[c.key] -= give; over -= give; } } }; // the others give room, down to their whole header
        const squeezeFlex = () => { let over = total() - avail; for (const c of flex) { if (over <= 0) break; const give = Math.min(over, base[c.key] - (c === prim ? hardOf(c) : minOf(c))); if (give > 0) { base[c.key] -= give; over -= give; } } }; // and the flexible ones, down to their own floor
        while (total() > avail) { const next = active.filter(c => c !== prim && c.drop && !st.pinned?.has(c.key)).sort((x, y) => x.drop - y.drop)[0]; if (!next) break; active = active.filter(c => c !== next); dropped.add(next.key); } // the optional columns go, the lowest priority first
        squeezeOthers(); squeezeFlex();
        for (let guard = 0; !cfg.keepColumns && total() > avail && guard < 24; guard++) { const next = [...active].reverse().find(c => c !== prim && !isFlex(c) && !fixedW(c) && !st.pinned?.has(c.key)); if (!next) break; active = active.filter(c => c !== next); dropped.add(next.key); } // a table with no priorities of its own and still too wide at its header widths: the last columns go, rightmost first, before anything scrolls (#11943); a table whose columns are all data (cfg.keepColumns: a CSV) keeps every column and scrolls in its box (csv_viewer, the v2.0.35 gate)
        // what the person widened (a drag, a key, a width kept from an earlier visit) is applied to the columns that stayed: the elastic column pays first, then the others; nothing more is dropped because of it
        for (const c of active) { const k = st.widths[c.key]; if (!k) continue; if (!isFlex(c)) { if (!fixedW(c)) w[c.key] = Math.min(MAX_W, Math.max(minOf(c), k)); } else if (c !== prim) base[c.key] = Math.max(base[c.key], k); }
        if (prim && st.widths[prim.key]) base[prim.key] = Math.max(base[prim.key], Math.min(st.widths[prim.key], MAX_W));
        { let over = total() - avail; if (prim && over > 0) { const give = Math.min(over, base[prim.key] - hardOf(prim)); if (give > 0) { base[prim.key] -= give; over -= give; } } }
        squeezeOthers(); squeezeFlex();
        const others = active.reduce((n, c) => n + (isFlex(c) ? 0 : w[c.key]), chk);
        if (prim) base[prim.key] = Math.max(hardOf(prim), Math.min(pref[prim.key], avail - others - flex.filter(c => c !== prim && active.includes(c)).reduce((n, c) => n + base[c.key], 0)));
        const set = new Set(flex.filter(c => active.includes(c))); let free = avail - others;
        for (let pass = 0; pass < 8 && set.size; pass++) { // by shares: a column whose part is below its floor keeps the floor
            const sum = [...set].reduce((n, c) => n + (c.share || 1), 0); let moved = false;
            for (const c of [...set]) { const part = free * (c.share || 1) / sum; if (part < base[c.key]) { w[c.key] = base[c.key]; free -= w[c.key]; set.delete(c); moved = true; } }
            if (!moved) break;
        }
        { const sum = [...set].reduce((n, c) => n + (c.share || 1), 0); for (const c of set) w[c.key] = Math.max(base[c.key], Math.round(free * (c.share || 1) / sum)); }
        const floor = prim ? base[prim.key] : 0;
        tightKeys = dropped;
        syncHidden(dropped);
        for (const c of columns) for (const n of box.querySelectorAll(`th.dt-th[data-key="${attrEsc(c.key)}"], td.dt-td[data-key="${attrEsc(c.key)}"]`)) n.classList.toggle('dt-col-tight', dropped.has(c.key));
        colgroup.replaceChildren();
        if (sel) { const k = el('col'); k.style.width = chkTh ? `${chk}px` : 'var(--table-check-w)'; colgroup.append(k); }
        for (const c of columns) { const k = el('col'); if (getEmptyKeys().has(c.key) || cssHides(c)) k.classList.add('dt-col-unused'); else if (dropped.has(c.key)) k.classList.add('dt-col-tight'); else k.style.width = `${w[c.key]}px`; colgroup.append(k); }
        table.style.tableLayout = 'fixed'; table.style.width = `${Math.max(avail, chk + active.reduce((n, c) => n + w[c.key], 0))}px`;
        box.classList.add('dt-sized'); box.style.setProperty('--dt-sized-min', '0px');
        L0 = { avail, w, prim, hard: prim ? Math.max(ITEM_MIN, minOf(prim)) : 0, others: others + active.reduce((n, c) => n + (isFlex(c) && c !== prim ? w[c.key] : 0), 0), floor, chk, active };
        for (const th of thead.querySelectorAll('th.dt-th')) { const c = columns.find(x => x.key === th.dataset.key), h = th.querySelector('.dt-resize'); if (c && h && w[c.key]) { h.setAttribute('aria-valuenow', String(w[c.key])); h.setAttribute('aria-valuemin', String(minOf(c))); } }
        { const movable = active.filter(x => !fixedW(x)); for (const th of thead.querySelectorAll('th.dt-th')) { const h = th.querySelector('.dt-resize'), at = movable.findIndex(x => x.key === th.dataset.key); if (h) h.hidden = at < 0 || at === movable.length - 1; } } // the last column on show has nothing on its right to give or take room: no handle (#12409)
    }
    /** Move the edge on the right of column c (#12409, Beta Tester on v2.0.35): the edge goes where the pointer goes. c takes the width and the columns on its right give it, the nearest first, each down to its floor (the elastic column down to the name's floor);
     *  a drag the other way gives the room to the nearest. The elastic column is whatever the others leave, so it is never written down; the table keeps its width. `snap` is the layout the drag began on, so a drag that hit a floor and comes back is where it was. */
    function setWidth(c, w, th, snap) {
        applyWidths(); // the room is read from a layout of the box as it is now
        const h = th && th.querySelector('.dt-resize');
        if (!L0) return;
        const S = snap || { w: { ...L0.w } }, cols = L0.active.filter(x => !fixedW(x)), i = cols.indexOf(c), pool = i < 0 ? [] : cols.slice(i + 1);
        if (!pool.length) { if (h) h.setAttribute('aria-valuenow', String(L0.w[c.key] || 0)); return; } // the last column's edge is the table's: nothing on its right to give or take room
        const floorOf = y => (y === L0.prim ? L0.hard : Math.max(minOf(y), y.share ? 96 : 0)), cur = S.w[c.key] || 0, dx = Math.round(w) - cur, change = {};
        let newW = cur;
        if (dx >= 0) { let want = Math.min(dx, MAX_W - cur); for (const y of pool) { if (want <= 0) break; const t = Math.min(want, Math.max(0, (S.w[y.key] || 0) - floorOf(y))); if (t > 0) { change[y.key] = -t; want -= t; newW += t; } } }
        else { const shrink = Math.min(-dx, Math.max(0, cur - (c === L0.prim ? L0.hard : minOf(c)))); newW = cur - shrink; if (shrink > 0) change[pool[0].key] = shrink; }
        if (c !== L0.prim) st.widths[c.key] = Math.round(newW);
        for (const y of pool) if (change[y.key] && y !== L0.prim) st.widths[y.key] = Math.round((S.w[y.key] || 0) + change[y.key]);
        applyWidths();
        if (h) h.setAttribute('aria-valuenow', String(L0 && L0.w[c.key] || Math.round(newW)));
        syncHidden(tightKeys); // the bar offers Reset as soon as a width is kept
    }
    /** Back to the widths nobody dragged: the kept ones go, in this browser too. */
    function resetWidths() { st.widths = {}; saveWidths(); applyWidths(); }
    /** The width the column needs for its widest cell and its head (laid out at its natural width for a moment). */
    function fitWidth(c) { const live = columns.filter(x => !getEmptyKeys().has(x.key) && !cssHides(x)), n = measureNatural(live)[c.key] || 0; applyWidths(); return Math.min(800, n); }
    /** Fit the column to its content: when that is the width it has, nothing changed and nothing is kept (no Reset appears for it). */
    function fitTo(c, th) {
        const w = fitWidth(c);
        if (Math.abs(w - Math.round(th.getBoundingClientRect().width)) <= 1) return;
        setWidth(c, w, th); saveWidths();
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
            applyWidths(); const snap = { w: { ...(L0 ? L0.w : {}) } }, startX = e.clientX, start = snap.w[c.key] || now(); let moved = false;
            const move = (ev) => { if (!moved) { if (Math.abs(ev.clientX - startX) < 2) return; moved = true; } setWidth(c, start + (ev.clientX - startX), th, snap); }; // a press that does not move changes nothing: no frozen widths, no Reset
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); h.classList.remove('dt-resizing'); if (moved) saveWidths(); };
            h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
        });
        h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }); // fit the column to its content
        h.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? STEP * 3 : STEP;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setWidth(c, now() + (e.key === 'ArrowRight' ? step : -step), th); saveWidths(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }
        });
        return h;
    }

    return { applyWidths, resetWidths, resizeHandle };
}
