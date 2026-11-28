/* Activity's top line (the approved mock, #22100): Important | Everything stays a two-part switch, and the five kinds move into one Kind menu where each keeps its count and several can be ticked. Lazy: inbox_toolbar.js
 * loads it for the Activity bar. It replaces the row of seven tabs `showPills` (inbox_activity.js) describes; `pills.change(important, kinds)` keeps the choice. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { moreMenu } = await importOnce('./more_menu.js');
await loadStyles('activity_kind_menu.css');
export function mount(node, pills) {
    node.querySelector('.al-switch, .al-kind-menu')?.remove();
    node.querySelectorAll('.al-switch, .al-kind-menu').forEach(e => e.remove());
    const row = node.querySelector('.list-bar-search-row'), group = row && row.querySelector('.team-tb-pills');
    if (!group || !pills || !pills.change) return;
    group.classList.add('al-tabs-gone');
    const sw = document.createElement('div'); sw.className = 'al-switch'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Show');
    for (const [label, on] of [['Important', pills.important], ['Everything', !pills.important]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small al-switch-btn'; b.textContent = label; b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => { if (!on) pills.change(label === 'Important', pills.kinds); });
        sw.append(b);
    }
    const kinds = pills.items.filter(it => it.key !== 'important' && it.key !== 'all'), picked = pills.kinds;
    const items = [{ label: `All ${pills.items.find(it => it.key === 'all')?.count ?? ''}`.trim(), pressed: picked.length === 0, run: () => pills.change(pills.important, []) },
        ...kinds.map(k => ({ label: `${k.label} ${k.count}`, pressed: picked.includes(k.key), run: () => pills.change(pills.important, picked.includes(k.key) ? picked.filter(x => x !== k.key) : [...picked, k.key]) }))];
    const word = picked.length === 0 ? 'All' : picked.length === 1 ? kinds.find(k => k.key === picked[0])?.label || 'All' : `${picked.length} kinds`;
    const menu = moreMenu('inbox-activity-kind', items, { label: 'Kind', wrapClass: 'al-kind-menu task-more' });
    const button = menu.querySelector('button');
    button.textContent = `Kind: ${word} ▾`; button.setAttribute('aria-label', `Kind: ${word}`);
    const before = row.querySelector('.list-bar-chips-inrow') || row.querySelector('.list-bar-toggle') || row.querySelector('.list-bar-more');
    row.insertBefore(sw, before); row.insertBefore(menu, before);
}
