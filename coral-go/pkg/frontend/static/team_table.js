/* Small DOM, state-chip and return-focus helpers for team pages. All table rendering lives in data_table.js (#7797). */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The row of a table that holds `key`, and its button: where the focus goes back to when a page or the pane closes. */
export function rowFocusTarget(root, key) {
    const tr = root && [...root.querySelectorAll('tr[data-key]')].find(r => r.dataset.key === String(key));
    return tr ? tr.querySelector('.dt-primary') || tr : null;
}

/** A state as a dot and a word (the dot is decoration: the word says it). */
export function stateChip(word, cls) {
    const chip = el('span', `chip goal-chip ${cls || ''}`.trim());
    chip.append(el('span', 'goal-dot'), document.createTextNode(word));
    return chip;
}
