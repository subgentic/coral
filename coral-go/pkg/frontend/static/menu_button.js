/* A button that opens a menu of actions (#7407): the team dialog's More and each member's actions. The button has aria-haspopup="menu", aria-expanded and aria-controls (the menu's id);
 * the menu is role="menu" with role="menuitem" buttons. It opens on a click or ArrowDown with its first item focused; ArrowUp and ArrowDown, Home and End move; Escape closes it and gives the focus back
 * to the button (and is not the dialog's Escape); Tab, a click elsewhere or a choice closes it. It opens below the button, or above it when there is not room below inside the dialog's body: a menu
 * is never cut off by the footer. Only one is open at a time. */
import { menuMove } from './menu_keys.js';
import { keepMenuOnScreen } from './menu_fit.js';

let current = null; // { toggle, menu }

const items = menu => [...menu.querySelectorAll('[role="menuitem"]:not([disabled]):not([hidden])')];

export function closeMenus({ restoreFocus = false } = {}) {
    if (!current) return;
    const { toggle, menu } = current;
    current = null;
    menu.hidden = true;
    menu.classList.remove('team-menu-up');
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
}

function place(toggle, menu) {
    menu.classList.remove('team-menu-up');
    const box = toggle.closest('.settings-modal-body, .modal-content') || document.body;
    const room = box.getBoundingClientRect().bottom - toggle.getBoundingClientRect().bottom;
    if (menu.getBoundingClientRect().height > room - 8) menu.classList.add('team-menu-up');
    keepMenuOnScreen(menu, toggle);
}

export function openMenu(toggle, { focusFirst = true } = {}) {
    const menu = document.getElementById(toggle.getAttribute('aria-controls') || '');
    if (!menu) return;
    closeMenus();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    current = { toggle, menu };
    place(toggle, menu);
    if (focusFirst) items(menu)[0]?.focus();
}

/** The menu button's click: open it, or close it when it is open. */
export function toggleMenu(toggle) {
    if (current && current.toggle === toggle) closeMenus({ restoreFocus: true });
    else openMenu(toggle);
}

document.addEventListener('keydown', e => {
    if (!current) return;
    const { toggle, menu } = current;
    const on = document.activeElement;
    if (!(menu.contains(on) || on === toggle)) return;
    const list = items(menu);
    const i = list.indexOf(on);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus({ restoreFocus: true }); return; }
    if (e.key === 'Tab') { closeMenus(); return; }
    const to = menuMove(e.key, list.length, on === toggle ? -1 : i);
    if (to < 0) return;
    e.preventDefault();
    list[to]?.focus();
}, true); // capture: before the page's Escape closes the dialog behind the menu

document.addEventListener('click', e => {
    if (!current) return;
    const { toggle, menu } = current;
    if (toggle.contains(e.target)) return; // the button's own handler toggles
    if (menu.contains(e.target) && e.target.closest('[role="menuitem"]')) closeMenus(); // a choice closes it (the item's action runs on this same click)
    else if (!menu.contains(e.target)) closeMenus();
});

// ArrowDown on the closed button opens it.
document.addEventListener('keydown', e => {
    if (current || e.key !== 'ArrowDown') return;
    const t = e.target.closest && e.target.closest('[aria-haspopup="menu"][aria-controls]');
    if (t && t.closest('#launch-step-team')) { e.preventDefault(); openMenu(t); }
});
