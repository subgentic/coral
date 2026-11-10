// The search box over a settings view's rows (#15058): loaded only by a page that asks for it (spec.search), so it is not in the start bundle.

/** The search box over every row of the sections (#15058): the rows that match by label or help stay, each under its section's name; Enter opens the first one's section; Esc clears. */
export function searchBox(root, opts) {
    const shellEl = root.querySelector('.settings-shell');
    const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const box = node('div', 'tsg-search'); box.setAttribute('role', 'search');
    const input = node('input', 'field field-dense tsg-search-input'); input.type = 'search'; input.autocomplete = 'off'; input.placeholder = (opts && opts.placeholder) || 'Search settings'; input.setAttribute('aria-label', (opts && opts.label) || 'Search settings');
    const status = node('p', 'tsg-search-status'); status.setAttribute('role', 'status'); status.hidden = true;
    box.append(input, status);
    const rowsOf = pane => [...pane.querySelectorAll('.sv-row[data-key]:not(.sv-row-heading):not(.sv-row-notice)')].map(row => ({ row, field: { label: row.querySelector('.sv-label')?.textContent || '' } }));
    let first = null;
    function apply() {
        const q = input.value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
        root.classList.toggle('tsg-searching', !!q);
        first = null; let hits = 0;
        for (const pane of shellEl.querySelectorAll('.settings-pane')) {
            let hit = false;
            for (const r of rowsOf(pane)) {
                const text = (r.row.querySelector('.sv-text')?.textContent || r.field.label || '').toLowerCase();
                const on = !!q && !r.row.hidden && words.every(w => text.includes(w));
                if (on) { r.row.setAttribute('data-match', '1'); r.row.removeAttribute('data-nomatch'); hit = true; hits++; first = first || r; }
                else { r.row.removeAttribute('data-match'); if (q) r.row.setAttribute('data-nomatch', '1'); else r.row.removeAttribute('data-nomatch'); }
            }
            pane.toggleAttribute('data-hit', hit);
        }
        status.hidden = !q;
        status.textContent = !q ? '' : hits ? `${hits} ${hits === 1 ? 'setting matches' : 'settings match'}` : `No settings match \u201c${input.value.trim()}\u201d`;
    }
    function clear() { input.value = ''; apply(); }
    input.addEventListener('input', apply);
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); clear(); }
        // Enter: the first match's section opens, its control has the focus and the status says where it is (#15058)
        else if (e.key === 'Enter' && first) { e.preventDefault(); const row = first.row, id = row.closest('.settings-pane')?.dataset.section; const pane = row.closest('.settings-pane'), label = row.querySelector('.sv-label')?.textContent || ''; clear(); if (id) shellEl.querySelector(`.settings-tab[data-section="${id}"]`)?.click(); row.scrollIntoView({ block: 'center' }); row.setAttribute('data-match', '1'); setTimeout(() => row.removeAttribute('data-match'), 3000); row.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true }); status.hidden = false; status.textContent = `Opened ${pane?.dataset.title || 'the section'}: ${label}`; }
    });
    shellEl.querySelector('.settings-tabs')?.addEventListener('click', () => { if (input.value) clear(); });
    return box;
}

/** Puts the page's grouping on its rows (#15058): a field with level: 1 is a large heading (an h4 beside the pane's own), a field with under: 'toggle' hangs on that toggle. Called once the view is drawn. */
export function groupRows(root, groups) {
    for (const g of groups) for (const f of g.fields || []) {
        const row = root.querySelector(`.sv-row[data-key="${f.key}"]`); if (!row) continue;
        if (f.under) row.classList.add('tsg-dep');
        if (f.type === 'heading' && f.level !== 1) row.classList.add('tsg-sub');
        if (f.level === 1) { row.classList.add('tsg-big'); const h = row.querySelector('.sv-heading'); if (h) { const big = document.createElement('h4'); big.className = 'sv-heading tsg-big-h'; big.id = h.id; big.textContent = h.textContent; h.replaceWith(big); } }
    }
}
