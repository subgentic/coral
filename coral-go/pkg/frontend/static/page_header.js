/* One page header for every list page (design guidelines 4.2, #15814): two rows, the same order everywhere.
 *
 *   Row 1:  Title  count                                  [More]  [Primary]
 *   Row 2:  [Search…………]  [filter strip]  [filter icon]
 *
 * The title is the page-title size (20 px) with one grey count; at most one blue button, at the far right of row 1, and every other page action in More beside it; "Copy for an agent" is an item of More, with its
 * words (never a robot of its own). The list pages already draw their title, search, filter strip and filter icon as the children of one toolbar row (inbox_toolbar.js, team_toolbar.js); this puts that row into the
 * two-row order: pageHeader(row, { more, agentCopy }) adds the actions group (More and the Primary the toolbar adopted) and the sheet's rules (css/page_header.css, loaded with this module, not at start) do the
 * layout, so the order does not depend on the order the parts were drawn in. Called after every draw of the toolbar (it draws the Primary again each time); it leaves one actions group. Row 2 is the toolbar's own,
 * so a page with no filters has no row 2 (nothing is in it). Other pages adopt it in their own tasks.
 *
 *   more:      [{ label, title, run }] page actions besides the Primary
 *   agentCopy: { key, subject } the page's "Copy for an agent" item (agent_doc_map.js), put last in More */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { copyText, showToast } from './utils.js';
const { moreMenu } = await importOnce('./more_menu.js');
const { agentCopyText } = await importOnce('./agent_doc_map.js');

await loadStyles('page_header.css');

export const COPY_FOR_AGENT = 'Copy for an agent';

/** Put `row` (a list toolbar's one row) into the page header layout. `idp`: an id prefix for the More menu. Returns the actions group. */
export function pageHeader(row, { idp, more = [], agentCopy = null } = {}) {
    if (!row) return null;
    row.classList.add('page-header');
    row.querySelector(':scope > .page-header-actions')?.remove();
    const primary = row.querySelector(':scope > .team-tb-action'); // the toolbar's create button, drawn again at each draw
    const items = [...more];
    if (agentCopy) items.push({ label: COPY_FOR_AGENT, title: 'Copy this page’s command and where an agent reads about it', separatorBefore: items.length > 0, run: () => copyText(agentCopyText(agentCopy.key, typeof agentCopy.subject === 'function' ? agentCopy.subject() : agentCopy.subject || '')).then(ok => showToast(ok ? 'Copied: paste it to an agent' : 'Could not copy', !ok)) });
    const group = document.createElement('div'); group.className = 'page-header-actions';
    if (items.length) group.append(moreMenu(`${idp || 'page'}-more`, items, { label: 'More actions', wrapClass: 'page-header-more', menuClass: 'page-header-more-menu' }));
    if (primary) group.append(primary);
    row.append(group);
    return group;
}
