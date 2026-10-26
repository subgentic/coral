/* The toolbar of an Inbox folder's page (#8596, goal #62; UI/UX #8589 section 9): the shared list bar (list_bar.js), the same one the team tabs and the Inbox's Tasks folder use: the search box, the Filters icon
 * right beside it at its right end, the folder's pills after it (team_toolbar.js adopt), the chips of what is on below. A folder declares its fields (a list bar spec) and its model (a pure filters module,
 * like goal_filters.js); this draws them and keeps the focus where it was when the page redraws under a poll.
 *
 *   const tb = folderToolbar({ idp: 'inbox-goals', noun: 'goal', searchLabel: 'Search goals', fields, sorts, model }, filters => { ... });
 *   tb.draw({ filters, pills: { label, items: [{ key, label, count }], current, onPick(key) }, options: { team: { values, labels } } })  ->  the toolbar's node
 * The Filters panel stays shut across redraws (the bar is built once); the sidebar (the folder list) is not touched. */
import { importOnce } from './import_once.js';
const { buildListBar } = await importOnce('./list_bar.js');
const Toolbar = await importOnce('./team_toolbar.js');

/** A folder's toolbar: `spec` is a list bar spec without the shared parts (idp, noun, label, searchLabel, placeholder, fields, sorts, model); `onChange(filters)` is told the new, clean filters. */
export function folderToolbar(spec, onChange) {
    const bar = buildListBar({ hideCount: true, collapsible: true, compactPanel: true, doneButton: true, sheet: true, label: `Search and filter ${spec.noun}s`, placeholder: spec.searchLabel, ...spec }, onChange, {});
    bar.node.classList.add('inbox-folder-toolbar');
    const row = bar.node.querySelector('.list-bar-search-row');
    row.classList.add('gt-toolbar');
    return {
        bar,
        /** Show `filters` in the bar, fill the select options that follow the data, and put the pills in the row; the focus stays on the control that had it. */
        draw({ filters, pills = null, options = {} }) {
            bar.set(filters);
            for (const [key, o] of Object.entries(options)) bar.setOptions(key, o.values, o.labels || {});
            const active = document.activeElement;
            const held = bar.node.contains(active) ? (active.matches('.team-tb-select') ? 'select' : active.dataset.filter) : null;
            Toolbar.adopt(row, { pills });
            if (held) {
                const next = held === 'select' ? bar.node.querySelector('.team-tb-select') : [...bar.node.querySelectorAll('[data-filter]')].find(e => e.dataset.filter === held);
                next?.focus({ preventScroll: true });
            }
            return bar.node;
        },
    };
}
