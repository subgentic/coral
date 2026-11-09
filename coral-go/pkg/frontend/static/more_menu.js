/* A text "More" button and its menu of actions (menu_button.js: arrow keys, Escape, the menu opens upward where there is no room below). Shared by the task page's bar (#9076) and the goal page's header on a
 * phone (#13119): the primary action stays a button, everything else is here. items: [{ label, title, ariaLabel, danger, className, run }]; the menu holds real buttons with role="menuitem". */
import { importOnce } from './import_once.js';

const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function moreMenu(id, items, { label = 'More actions', wrapClass = 'task-more', menuClass = 'task-more-menu', restoreFocus = false } = {}) {
    const wrap = make('span', wrapClass);
    const toggle = make('button', 'btn task-more-btn', 'More'); toggle.type = 'button'; toggle.id = id;
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`);
    const menu = make('div', `menu team-more-menu ${menuClass}`); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
    for (const it of items) {
        if (it.separatorBefore) { const hr = make('hr', 'menu-sep'); hr.setAttribute('role', 'separator'); menu.append(hr); } // (Delete last, set apart)
        const b = make('button', it.danger ? 'menu-item menu-item-danger mb-action-danger' : 'menu-item', it.description ? '' : it.label); b.type = 'button';
        if (it.description) { b.append(make('span', 'more-item-label', it.label), make('small', 'more-item-desc', it.description)); b.classList.add('menu-item-described'); } // what the item does, under its name
        b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus({ restoreFocus }); it.run(b); });
        if (it.pressed !== undefined) { b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(!!it.pressed)); } // a toggle (Star, Keep): its state is read aloud
        else b.setAttribute('role', 'menuitem'); if (it.title) b.title = it.title; if (it.ariaLabel) b.setAttribute('aria-label', it.ariaLabel); if (it.className) b.classList.add(...it.className.split(' '));
        menu.append(b);
    }
    // The menu code loads on first use. Start loading it when the button is built, and, if the page was drawn again while a tap was waiting for it (a goal's tasks arriving), open the menu on the button that is there now:
    // before, that tap went to a button that was no longer on the page and nothing happened (goal_operator_dialogs 'More opens' timing out on a phone under load, #14955).
    importOnce('./menu_button.js').catch(() => {});
    toggle.addEventListener('click', async () => {
        const m = await importOnce('./menu_button.js');
        m.toggleMenu(toggle.isConnected ? toggle : (document.getElementById(id) || toggle));
    });
    wrap.append(toggle, menu);
    return wrap;
}
