/* The sidebar kebab menu's keys (#15445), loaded the first time a menu opens so none of it is in the start graph: Up, Down, Home and End move between the items, and Tab closes the menu and goes on from its button. */
import { menuMove } from './menu_keys.js';
import { closeSidebarKebabs } from './sidebar_menus.js';
import { importOnce } from './import_once.js';

await importOnce('./menu_help.js').catch(() => {}); // size the first menu with its help sheet before it becomes a pointer target (#19188)

document.addEventListener('keydown', e => {
    const menu = e.target.closest?.('.sidebar-kebab-menu');
    if (!menu) return;
    if (e.key === 'Tab') { closeSidebarKebabs({ restoreFocus: true }); return; }
    const items = [...menu.querySelectorAll('.overflow-menu-item')].filter(i => i.getClientRects().length > 0); // the items that are shown: a team menu's More group is hidden until it is opened, and a hidden item cannot take the focus (End and Down stopped on it)
    const to = menuMove(e.key, items.length, items.indexOf(document.activeElement));
    if (to >= 0) { e.preventDefault(); items[to].focus(); }
}, true);

/** Position the opening only after its help has its final size. Cancelled openings never reach here. */
export function placeSidebarMenu(btn, menu, event) {
    // Measured hidden; the tablet drawer (#15258) transforms and clips, so its box is the window
    window.menuHelp?.(menu); // menu_help.js (fetched by kebab_keys.js) sets it: lines drawn before the menu is measured (#17492)
    const r = btn.getBoundingClientRect(), sb = menu.closest('.tablet-open');
    const x = sb ? sb.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
    // A menu longer than the screen scrolls inside it and never runs past its edge: a phone's row menu is 16 items (#17333), and Stop at the foot must be reachable.
    menu.style.maxHeight = Math.max(120, Math.min(x.height, innerHeight) - 16) + 'px'; menu.style.overflowY = 'auto';
    const h = menu.offsetHeight, w = menu.offsetWidth;
    const want = r.bottom + h > x.bottom ? r.top - h : r.bottom + 2;
    menu.style.top = Math.max(8, Math.min(want - x.top, Math.min(x.height, innerHeight) - h - 8)) + 'px';
    menu.style.left = Math.min(r.left - x.left, x.width - w - 8) + 'px';
    menu.style.visibility = '';
    // Opened from the keyboard (Enter or Space is a click with no pointer): the focus goes to the first item.
    if (event?.detail === 0) menu.querySelector('.overflow-menu-item')?.focus({ preventScroll: true });
}
