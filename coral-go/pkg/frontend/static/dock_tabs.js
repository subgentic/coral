/* The agent's side panel tabs say their words (UI/UX's 170 list, item 1, #7621; #15855): every tab the page has stays in the row, in the order the person gave in Customize tabs, and shows its word beside its icon
 * when ALL the words fit the row on one line. When they do not, every tab is an icon alone (no word, no count; the title and the aria-label name it), and when even the icons do not fit the row scrolls sideways with
 * every tab reachable: there is no More menu, so no tab ever moves because another was opened or a count changed (#21684). */
import { watchScrollCue } from './scroll_cue.js';

const strip = () => document.querySelector('#agentic-block-top .agentic-state-tabs');
const shown = b => getComputedStyle(b).display !== 'none'; // the page's rules and .tab-hidden say which tabs this page has

/** The words fit when every tab of the row is on one line with them showing and none is clipped (measured, so a narrow panel, a large text size and an unusual word all fall back the same way); else icons alone. */
export function fitWords() {
    const row = strip();
    if (!row) return;
    const tabs = [...row.querySelectorAll('.agentic-tab')].filter(shown);
    if (tabs.length === 0) return;
    row.toggleAttribute('data-words', true); // on, to look (no write when already on)
    const top = tabs[0].offsetTop;
    const crowded = tabs.some(b => b.offsetTop !== top || b.scrollWidth > b.clientWidth + 1) || (row.scrollWidth > row.clientWidth && !row.closest('.mobile-panel-overlay'));
    if (crowded) row.removeAttribute('data-words');
}

export function initDockTabs() {
    document.addEventListener('coral:dock-changed', fitWords); // a tab was switched
    const state = document.getElementById('agentic-state');
    if (state) new MutationObserver(fitWords).observe(state, { attributes: true, attributeFilter: ['class', 'data-page'] }); // a page, or the customizer's hidden tabs
    const row = strip();
    if (row) {
        const ro = new ResizeObserver(fitWords);
        ro.observe(row);
        for (const b of row.children) ro.observe(b); // a larger text size or a new count widens the tabs, not the row (#9435)
        watchScrollCue(row);
    } // the strip scrolls sideways when the icons do not fit: a fade says which edge hides tabs
}
