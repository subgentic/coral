// Needs you keeps its kind choices on one line; the same choices become a menu when space runs out (#19470).
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { setHidden } from './dom_write.js';
const { moreMenu } = await importOnce('./more_menu.js');
await loadStyles('inbox_kind_menu.css');
export function mount(node, pills) {
    node._kindObserver?.disconnect();
    node.querySelector('.inbox-kind-control')?.remove();
    const row = node.querySelector('.list-bar-search-row'), group = row.querySelector('.team-tb-pills');
    if (!group || !pills) return;
    const menu = moreMenu('inbox-kind', (pills.menuItems || pills.items).map(it => ({ label: `${it.label}${it.count == null ? '' : ' '+it.count}`, pressed: it.key === pills.current, run: () => pills.onPick(it.key) })), { label: 'Kind', wrapClass: 'inbox-kind-control task-more' });
    const button = menu.querySelector('button');
    button.textContent = 'Kind'; button.setAttribute('aria-label', `Kind: ${(pills.menuItems || pills.items).find(it => it.key === pills.current)?.label || 'All'}`);
    const toggle = row.querySelector('.list-bar-toggle');
    row.insertBefore(menu, toggle?.parentElement === row ? toggle : row.querySelector('.nl-toolbar-actions'));
    group.classList.add('inbox-kind-strip');
    const fit = () => {
        if (!node.isConnected) { node._kindObserver?.disconnect(); return; }
        if (pills.menuItems) { setHidden(group, false); setHidden(menu, false); return; } // quick views and Kind are distinct controls in the ledger
        // Measure the unwrapped strip against its search row, excluding the title, the two tabs (their own line) and bulk-action rows.
        setHidden(group, false); setHidden(menu, true);
        const others = [...row.children].filter(e => e !== group && e !== menu && !e.matches('.inbox-folder-head,.inbox-needs-tabs,.needs-more,.team-tb-selection') && e.getClientRects().length);
        const needed = group.getBoundingClientRect().width + others.reduce((n, e) => n + (e.matches('.list-bar-search-wrap') ? parseFloat(getComputedStyle(e).minWidth) || 160 : e.getBoundingClientRect().width), 0) + (others.length * (parseFloat(getComputedStyle(row).columnGap) || 0));
        const compact = needed > row.clientWidth || innerWidth < 768;
        setHidden(group, compact); setHidden(menu, !compact);
    };
    node._kindObserver = new ResizeObserver(fit); node._kindObserver.observe(row);
    requestAnimationFrame(fit);
    document.fonts?.ready.then(fit);
}
