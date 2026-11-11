/* The sidebar kebab menu's keys (#15445), loaded the first time a menu opens so none of it is in the start graph: Up, Down, Home and End move between the items, and Tab closes the menu and goes on from its button. */
import { menuMove } from './menu_keys.js';
import { closeSidebarKebabs } from './sidebar_menus.js';

document.addEventListener('keydown', e => {
    const menu = e.target.closest?.('.sidebar-kebab-menu');
    if (!menu) return;
    if (e.key === 'Tab') { closeSidebarKebabs({ restoreFocus: true }); return; }
    const items = [...menu.querySelectorAll('.overflow-menu-item')].filter(i => i.getClientRects().length > 0); // the items that are shown: a team menu's More group is hidden until it is opened, and a hidden item cannot take the focus (End and Down stopped on it)
    const to = menuMove(e.key, items.length, items.indexOf(document.activeElement));
    if (to >= 0) { e.preventDefault(); items[to].focus(); }
}, true);
