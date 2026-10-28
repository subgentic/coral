/* A menu that has just opened stays inside the screen (#10275, Mobile pass 19: a workflow's More menu hung from the right edge of a button at the left of the bar, and opened at x = -90 with Delete cut off).
 * Above its button when there is no room below; then moved sideways by as much as it hangs over an edge. Call it right after the menu is shown, with the button it hangs from. */
const GAP = 8;

export function keepMenuOnScreen(menu, toggle) {
    if (!menu || menu.hidden) return;
    menu.style.translate = '';
    menu.style.top = ''; menu.style.bottom = '';
    let r = menu.getBoundingClientRect();
    const t = toggle && toggle.getBoundingClientRect();
    if (t && r.bottom > innerHeight - GAP && t.top - r.height - 4 >= GAP) { // no room below, room above
        menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 4px)';
        r = menu.getBoundingClientRect();
    }
    let dx = 0;
    if (r.left < GAP) dx = GAP - r.left;
    else if (r.right > innerWidth - GAP) dx = innerWidth - GAP - r.right;
    if (dx) menu.style.translate = `${Math.round(dx)}px 0`;
}
