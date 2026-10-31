/* Small DOM, state-chip and return-focus helpers for team pages. All table rendering lives in data_table.js (#7797). */
import { importOnce } from './import_once.js';
const { chip } = await importOnce('./data_table.js'); // lazy: the one state label
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The row of a table that holds `key`, and its button: where the focus goes back to when a page or the pane closes. */
export function rowFocusTarget(root, key) {
    const tr = root && [...root.querySelectorAll('tr[data-key]')].find(r => r.dataset.key === String(key));
    return tr ? tr.querySelector('.dt-primary') || tr : null;
}

/** A state as a dot and a word (the dot is decoration: the word says it): the data table's one builder. */
export function stateChip(word, cls) { const c = chip(word, cls); c.classList.remove('dt-chip'); return c; } // a table's own tests count .dt-chip: this one is a team page's, not a cell
