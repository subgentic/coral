/* The table the team page's tabs share (#7453, the style guide's table pattern): a header row, one row per item, the first column a button that opens the row, and the whole row clickable for a pointer.
 * Built with the DOM and textContent only: every cell is text an agent or a person wrote.
 *   teamTable({ label, columns: ['Goal', 'State', ...], rows: [{ key, cells: [Node|string, ...], open?(row), current? }] })
 *   rowButton(text, ariaLabel?)  the button for a row's first cell (named by its text unless a label is given)
 * A row that has `open` is marked with aria-current while `current` is true (the selected row, #7453); the keyboard opens it through its button, the pointer anywhere in the row. */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function rowButton(text, label) {
    const b = el('button', 'team-row-btn', text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
}

const INTERACTIVE = 'a, input, select, textarea, summary, button:not(.team-row-btn)';

export function teamTable({ label, columns, rows, className = '' }) {
    const table = el('table', `team-table${className ? ' ' + className : ''}`);
    table.setAttribute('aria-label', label);
    const head = el('tr');
    for (const c of columns) { const th = el('th', null, c); th.scope = 'col'; head.append(th); }
    const thead = el('thead'); thead.append(head); table.append(thead);
    const body = el('tbody');
    for (const r of rows) {
        const tr = el('tr');
        tr.dataset.key = String(r.key);
        r.cells.forEach((cell, i) => {
            const td = el('td');
            td.dataset.col = String(i);
            if (cell instanceof Node) td.append(cell); else td.textContent = cell == null ? '' : String(cell);
            tr.append(td);
        });
        if (r.open) {
            tr.classList.add('team-row-open');
            tr.addEventListener('click', (e) => { if (e.target.closest(INTERACTIVE)) return; r.open(tr); });
        }
        if (r.current) tr.setAttribute('aria-current', 'true');
        body.append(tr);
    }
    table.append(body);
    const box = el('div', 'team-table-scroll'); box.append(table); // a table wider than the page scrolls in its own box, the lines above it stay put
    return box;
}

/** The row of a table that holds `key`, and its button: where the focus goes back to when a page or the pane closes. */
export function rowFocusTarget(root, key) {
    const tr = root && [...root.querySelectorAll('tr[data-key]')].find(r => r.dataset.key === String(key));
    return tr ? tr.querySelector('.team-row-btn') || tr : null;
}

/** A state as a dot and a word (the dot is decoration: the word says it). */
export function stateChip(word, cls) {
    const chip = el('span', `goal-chip ${cls || ''}`.trim());
    chip.append(el('span', 'goal-dot'), document.createTextNode(word));
    return chip;
}
