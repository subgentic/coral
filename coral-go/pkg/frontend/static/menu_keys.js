/* The one menu keyboard (#9243, Goal #88 item 1; the keys were written for the phone menus in #9116): ArrowDown and ArrowUp move to the next and the previous entry and wrap around, Home and End are the first and the last,
 * and from the button that opened the menu (nothing in the menu has the focus) ArrowDown is the first entry and ArrowUp the last. Every menu of the page (the hamburger, the composer's chevron, the sidebar's kebab, the team page's
 * More menus) asks this function which entry to focus; each keeps its own way of opening and closing (Escape, Tab and the click outside are the menu's own: they differ in what has the focus after). menu_census.test.mjs fails
 * a script that writes the same index arithmetic again. */

export const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** The index of the entry to focus for `key` among `count` entries, from the entry at `at` (-1 when the button or nothing in the list has the focus); -1 when the key does not move or there is no entry. */
export function menuMove(key, count, at) {
    if (!(count > 0)) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % count;
    if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
    return -1;
}
