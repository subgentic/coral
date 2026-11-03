/* The team page's tab strip rests on a tab's edge (#12538, the Mobile Beta Tester after Launch team: the page landed on Board, the last tab, and the strip stopped part-way through 'Agents 3', so its first visible tab read 'ents 3').
 * The selected tab is whole, and no tab is cut at the left: the strip starts at the first tab that lets the selected one end inside the window (at 0 when it already does). A strip whose end is too near for that gets
 * room after its last tab (padding-inline-end), so the last tab can sit at the right with the one before it whole. The right edge keeps its fade: more tabs lie that way. */
export function revealInStrip(strip, tab) {
    if (!strip || !tab || !strip.getClientRects().length || !tab.getClientRects().length) return;
    strip.style.paddingInlineEnd = ''; // measured as the stylesheet has it
    const tabs = [...strip.querySelectorAll('[role=tab]')].filter(t => t.getClientRects().length);
    const sr = strip.getBoundingClientRect(), cs = getComputedStyle(strip), padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const at = t => { const r = t.getBoundingClientRect(); return { l: r.left - sr.left + strip.scrollLeft, r: r.right - sr.left + strip.scrollLeft }; };
    const view = strip.clientWidth, a = at(tab);
    let target = 0;
    if (a.r > view - padR) {
        const first = tabs.find(t => a.r - at(t).l <= view - padL - 32); // 32 px: the fade at the strip's left edge
        target = Math.max(0, (first ? at(first).l : a.l) - padL);
    }
    const max = strip.scrollWidth - view;
    if (target > max) strip.style.paddingInlineEnd = `${padR + target - max}px`;
    strip.scrollLeft = target;
}
