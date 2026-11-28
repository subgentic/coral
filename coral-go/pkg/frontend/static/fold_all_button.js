/* The expand-all / collapse-all icon on a list's toolbar (#22056, the Operator): one button that opens every group or goal in the list, or folds them all, named for what it will do next.
 * `isOpen()` says whether everything is open (true), something is shut (false) or there is nothing to fold (null: the button is hidden); `setAll(open)` does it. `sync()` redraws the icon and the words. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { el } = await importOnce('./dom_el.js');
await loadStyles('fold_all_button.css');

export function foldAllButton(what, { isOpen, setAll }) {
    const b = el('button', 'btn btn-quiet btn-icon fold-all'), icon = el('span', 'material-icons'); b.type = 'button'; icon.setAttribute('aria-hidden', 'true'); b.append(icon);
    b.sync = () => {
        const open = isOpen(), words = `${open ? 'Collapse' : 'Expand'} all ${what}`;
        b.hidden = open === null; icon.textContent = open ? 'unfold_less' : 'unfold_more'; b.title = words; b.setAttribute('aria-label', words);
    };
    b.addEventListener('click', () => { setAll(!isOpen()); b.sync(); });
    b.sync();
    return b;
}
