// The items of a row's ⋯ menu (#137104), built when the menu is first opened: kept out of the start bundle (start bytes, #21915).
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('row_more_items.css');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export function fillMenu(menu, id, actions) {
    menu.classList.add('row-action-menu');
    for (const a of actions) {
        if (a.separatorBefore) { const hr = el('hr', 'menu-sep'); hr.setAttribute('role', 'separator'); menu.append(hr); }
        const b = el('button', a.danger ? 'menu-item menu-item-danger mb-action-danger' : 'menu-item', a.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); if (a.title) b.title = a.title;
        if (a.help) {
            b.classList.add('menu-item-with-help'); b.setAttribute('aria-label', a.label);
            const help = el('span', 'menu-item-state', a.help); help.id = `${id}-help-${menu.children.length}`;
            b.setAttribute('aria-describedby', help.id); b.append(help);
        }
        if (a.off) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); } // an action that is off right now stays in the menu, said off (the first in a line cannot move up)
        b.addEventListener('click', async e => {
            e.stopPropagation();
            if (a.confirm && !b.dataset.armed) { // an action that asks once more (Kick): the first press says so in the item's words and keeps the menu open, the second does it
                b.dataset.armed = '1'; b.textContent = a.confirm; if (a.onArm) a.onArm(b);
                setTimeout(() => { delete b.dataset.armed; b.textContent = a.label; }, 10000);
                return;
            }
            (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: true }); a.run(b);
        });
        menu.append(b);
    }
}
