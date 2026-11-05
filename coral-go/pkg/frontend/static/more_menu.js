/* A text "More" button and its menu of actions (menu_button.js: arrow keys, Escape, the menu opens upward where there is no room below). Shared by the task page's bar (#9076) and the goal page's header on a
 * phone (#13119): the primary action stays a button, everything else is here. items: [{ label, title, ariaLabel, danger, className, run }]; the menu holds real buttons with role="menuitem". */
import { importOnce } from './import_once.js';

const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function moreMenu(id, items, { label = 'More actions', wrapClass = 'task-more', menuClass = 'task-more-menu' } = {}) {
    const wrap = make('span', wrapClass);
    const toggle = make('button', 'btn task-more-btn', 'More'); toggle.type = 'button'; toggle.id = id;
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`);
    const menu = make('div', `menu team-more-menu ${menuClass}`); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
    for (const it of items) {
        const b = make('button', it.danger ? 'menu-item menu-item-danger mb-action-danger' : 'menu-item', it.label); b.type = 'button';
        b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); it.run(); });
        b.setAttribute('role', 'menuitem'); if (it.title) b.title = it.title; if (it.ariaLabel) b.setAttribute('aria-label', it.ariaLabel); if (it.className) b.classList.add(...it.className.split(' '));
        menu.append(b);
    }
    toggle.addEventListener('click', async () => (await importOnce('./menu_button.js')).toggleMenu(toggle));
    wrap.append(toggle, menu);
    return wrap;
}
