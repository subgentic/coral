/* The one "Details" disclosure of an artifact or a document (#7775, the operator: "we don't need to see all this detail every time ... reserve the space for the actual content"): the content comes straight under the
 * header, and the facts and "Who can read this" are behind a quiet text button, closed to begin with. It is the documents pane's (detail_pane.js: the team page's Artifacts and Knowledge, the agent dock's Artifacts)
 * and the artifact viewer's, one rule. Whether it is open is remembered for the viewer (one switch for all of them), and the button only exists while there is something behind it.
 *
 *   const d = makeDetails({ panel })      d.button (put it in the header row)   d.panel (put it under the header)   d.add(node)   d.clear()
 * add() makes the button appear; the panel is shown only while the button says it is open (aria-expanded, aria-controls). */
import { browserLocal } from './safe_storage.js';

const KEY = 'coral-details-open';
let serial = 0;

export function makeDetails({ panel = null } = {}) {
    const p = panel || document.createElement('div');
    p.classList.add('detail-details');
    if (!p.id) p.id = `details-panel-${++serial}`;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'details-toggle'; button.hidden = true;
    button.setAttribute('aria-controls', p.id);
    const chevron = document.createElement('span'); // turns when open, as More options and Who can read this do
    chevron.className = 'material-icons details-toggle-chevron'; chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = 'expand_more';
    button.append('Details', chevron);
    let used = false;
    const isOpen = () => browserLocal.get(KEY) === '1';
    const sync = () => {
        const open = isOpen() && used;
        button.hidden = !used; button.setAttribute('aria-expanded', String(open)); p.hidden = !open;
    };
    button.addEventListener('click', () => { browserLocal.set(KEY, isOpen() ? '0' : '1'); sync(); });
    sync();
    return {
        button, panel: p,
        add(node) { p.append(node); used = true; sync(); },
        clear() { p.replaceChildren(); used = false; sync(); },
    };
}
