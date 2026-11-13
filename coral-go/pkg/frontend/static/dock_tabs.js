/* The agent's side panel tabs say their words (UI/UX's 170 list, item 1, #7621): at 1280 px and up each tab shows its word beside its icon when ALL the words fit the row on one line (a panel dragged narrow,
 * or text at 200%, falls back to icons alone, whose name is the title and the aria-label: no word is clipped and the row does not wrap), and the three rarely used tabs (Notes, Agent UI, Branches), once turned on, sit behind one
 * More menu. They stay the real tab buttons (their panels, counts and handlers are the old ones): in More they are only drawn out of the way (.tab-more) and out of the tab order, and the menu's items
 * open them through switchAgenticTab. The open one swaps into the row and More stays (#15733). */
import { registerActions } from './actions.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { setHidden, setAttr, setHtml } from './dom_write.js';
import { menuMove } from './menu_keys.js';
import { watchScrollCue } from './scroll_cue.js';

const RARE = ['notes', 'agent-ui', 'branches'];
const WIDE = window.matchMedia('(min-width: 1280px)');
const $ = id => document.getElementById(id);
const strip = () => document.querySelector('#agentic-block-top .agentic-state-tabs');
const rareTabs = () => RARE.map(t => $(`agentic-tab-${t}`)).filter(Boolean);
const wordOf = b => b.getAttribute('aria-label') || b.dataset.tab;
const iconOf = b => b.querySelector('.material-icons')?.textContent || '';
const shown = b => getComputedStyle(b).display !== 'none'; // the page's own rules (data-page, data-scope) and the customizer's .tab-hidden say which tabs this page has
let menuOpen = false;

/** The words fit when every tab of the row is on one line with them showing and none is clipped: measured, so a narrow panel, a large text size and an unusual word all fall back the same way.
 *  The words are put on to look (only when they are off) and taken off again when they do not fit; with them already on it only looks. */
function fitWords() {
    const row = strip();
    if (!row) return;
    const on = row.hasAttribute('data-words');
    if (!WIDE.matches) { if (on) row.removeAttribute('data-words'); if (row.hasAttribute('data-active-word')) row.removeAttribute('data-active-word'); return; }
    const tabs = [...row.querySelectorAll('.agentic-tab')].filter(shown).filter(b => !b.classList.contains('tab-more'));
    if (tabs.length === 0) return;
    if (!on) row.setAttribute('data-words', '');
    const top = tabs[0].offsetTop;
    const crowded = () => tabs.some(b => b.offsetTop !== top || b.scrollWidth > b.clientWidth + 1) || row.scrollWidth > row.clientWidth;
    if (!crowded()) { if (row.hasAttribute('data-active-word')) row.removeAttribute('data-active-word'); return; }
    row.removeAttribute('data-words'); // not all on one line, or a word clipped in its tab: icons alone
    // ...but the open tab still says its word when that fits, whichever tab is open (#9999: eight icons and a newcomer guessing which one is Artifacts): each tab is tried as the open one
    // each tab on its own (#10876): one whose word does not fit at the panel's narrowest (Artifacts) does not take the word from Files; a tab that fits is marked, and the marked open one says its word
    const fit = tabs.map(b => { b.setAttribute('data-probe', ''); const ok = !crowded(); b.removeAttribute('data-probe'); if (b.hasAttribute('data-word-ok') !== ok) b.toggleAttribute('data-word-ok', ok); return ok; });
    const fits = fit.some(Boolean);
    if (fits !== row.hasAttribute('data-active-word')) { if (fits) row.setAttribute('data-active-word', ''); else row.removeAttribute('data-active-word'); }
}

let lastShape = '';
/** Which of the rare tabs this page has, drawn out of the row, and More as the one tab that opens them. Writes only what changed (the startup sequence counts every write). */
function syncMore() {
    const row = strip(), more = $('agentic-tab-more');
    if (!row || !more) return;
    const here = rareTabs().filter(shown);
    const open = here.find(b => b.classList.contains('active')); // the open one is a real tab of the row (#15733)
    const left = here.filter(b => b !== open);
    const was = open?.classList.contains('tab-more');
    for (const b of rareTabs()) {
        const away = left.includes(b);
        if (b.classList.contains('tab-more') !== away) b.classList.toggle('tab-more', away);
        if (away) { if (b.tabIndex !== -1) b.tabIndex = -1; setAttr(b, 'aria-hidden', 'true'); }
        else { if (b.hasAttribute('tabindex')) b.removeAttribute('tabindex'); if (b.hasAttribute('aria-hidden')) b.removeAttribute('aria-hidden'); }
    }
    if (was) open.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    setHidden(more, !left.length);
    setHtml($('agentic-more-menu'), left.map(b => `<button type="button" role="menuitem" class="menu-item agentic-more-item" data-on-click="dock-more-pick" data-on-keydown="dock-more-key" data-tab="${escapeAttr(b.dataset.tab)}"><span class="material-icons" aria-hidden="true">${escapeHtml(iconOf(b))}</span><span>${escapeHtml(wordOf(b))}</span><span class="agentic-more-count">${escapeHtml(b.querySelector('.agentic-tab-count')?.textContent || '')}</span></button>`).join(''));
    if (!left.length) closeMore(false);
    const shape = left.map(b => b.id).join();
    if (shape !== lastShape) { lastShape = shape; fitWords(); } // the set of tabs in the row changed: the words are looked at again
}

function closeMore(focus) {
    const menu = $('agentic-more-menu'), more = $('agentic-tab-more');
    if (!menu || !more) return;
    menuOpen = false;
    if (!menu.hidden) menu.hidden = true;
    setAttr(more, 'aria-expanded', 'false');
    if (focus) more.focus();
}

function openMore(first) {
    const menu = $('agentic-more-menu'), more = $('agentic-tab-more');
    if (!menu || !more || more.hidden) return;
    menuOpen = true;
    menu.hidden = false;
    const r = more.getBoundingClientRect(); // the row scrolls sideways on a phone and clips what is inside it: the menu is fixed to the screen, under More
    menu.style.top = `${Math.round(r.bottom + 4)}px`; menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    more.setAttribute('aria-expanded', 'true');
    const items = [...menu.querySelectorAll('[role=menuitem]')];
    (first === 'last' ? items[items.length - 1] : items.find(i => i.classList.contains('active')) || items[0])?.focus();
}

/** After a pick the menu is gone, and the item that had the focus with it: the focus goes to the panel that opened, named for its tab, so a keyboard or screen-reader user is
 *  where they asked to be (coral-hub's UI review of the Branches tab: never body or a hidden item). A panel that cannot take it (not shown) leaves the focus on More. */
function focusPanel(t) {
    const p = $(`agentic-panel-${t}`), tab = $(`agentic-tab-${t}`);
    if (p) {
        if (!p.hasAttribute('tabindex')) p.setAttribute('tabindex', '-1');
        if (tab && !p.hasAttribute('aria-label')) setAttr(p, 'aria-label', wordOf(tab));
        p.focus({ preventScroll: true });
    }
    if (document.activeElement !== p) $('agentic-tab-more')?.focus();
}

const items = () => [...($('agentic-more-menu')?.querySelectorAll('[role=menuitem]') || [])];

registerActions({
    'dock-more-toggle': () => { if (menuOpen) closeMore(true); else openMore(); },
    'dock-more-pick': el => { const t = el.dataset.tab; closeMore(false); if (RARE.includes(t)) { window.switchAgenticTab?.(t, 'top'); focusPanel(t); } },
    'dock-more-key': (el, event) => {
        const list = items(), i = list.indexOf(el);
        if (event.key === 'Escape') { event.preventDefault(); closeMore(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); list[menuMove(event.key, list.length, i)]?.focus(); }
        else if (event.key === 'Tab') closeMore(false);
    },
    'dock-more-open-key': (el, event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openMore(); } else if (event.key === 'ArrowUp') { event.preventDefault(); openMore('last'); } else if (event.key === 'Escape' && menuOpen) { event.preventDefault(); closeMore(true); } },
});

export function initDockTabs() {
    syncMore();
    document.addEventListener('coral:dock-changed', syncMore); // a tab was switched
    const state = $('agentic-state');
    if (state) new MutationObserver(syncMore).observe(state, { attributes: true, attributeFilter: ['class', 'data-page'] }); // a page, or the customizer's hidden tabs
    const row = strip();
    if (row) {
        const ro = new ResizeObserver(fitWords);
        ro.observe(row);
        const watchTabs = () => { for (const b of row.children) ro.observe(b); };
        watchTabs(); // with the words on the row does not wrap (agentic.css), so a larger text size or a tab's new count widens the tabs and leaves the row's size alone: the tabs are watched, and the words come off when they do not fit (#9435)
        new MutationObserver(() => { watchTabs(); fitWords(); }).observe(row, { childList: true }); // a tab added from script (the Sub-agents tab, #16016) is measured like the others
        watchScrollCue(row);
    } // the phone's overlay strip scrolls: a fade says which edge hides tabs
    WIDE.addEventListener('change', fitWords);
    document.addEventListener('click', e => { if (menuOpen && !e.target.closest?.('#agentic-more, #agentic-more-menu')) closeMore(false); }); // the menu is beside the More wrapper (#10214): both are the control
    document.addEventListener('focusout', e => { if (menuOpen && e.relatedTarget && !e.relatedTarget.closest?.('#agentic-more, #agentic-more-menu')) closeMore(false); });
}
