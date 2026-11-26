/* The agent's side panel tabs say their words (#7621, #15855): every tab the page has stays in the row, in Customize tabs' order, with its word when ALL the words fit on one line, else icons alone (title and aria-label
 * name them). Only when icons do not fit do the LAST tabs go under one More at the END of the row, by the row's width alone, never by the open tab or a count (#21684); More lights when the open tab is behind it. */
import { registerActions } from './actions.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { setHidden, setAttr, setHtml } from './dom_write.js';
import { menuMove } from './menu_keys.js';
import { watchScrollCue } from './scroll_cue.js';

const $ = id => document.getElementById(id);
const strip = () => document.querySelector('#agentic-block-top .agentic-state-tabs');
const wordOf = b => b.getAttribute('aria-label') || b.dataset.tab;
const iconOf = b => b.querySelector('.material-icons')?.textContent || '';
const shown = b => getComputedStyle(b).display !== 'none'; // the page's rules and .tab-hidden say which tabs this page has
let menuOpen = false;

/** The words fit when every tab is on one line with them showing and none is clipped (measured); else icons alone. */
export function fitWords() {
    const row = strip();
    if (!row) return;
    const tabs = [...row.querySelectorAll('.agentic-tab')].filter(shown).filter(b => !b.classList.contains('tab-more'));
    if (tabs.length === 0) return;
    row.toggleAttribute('data-words', true); // on, to look (no write when already on)
    const top = tabs[0].offsetTop;
    const crowded = () => tabs.some(b => b.offsetTop !== top || b.scrollWidth > b.clientWidth + 1) || (row.scrollWidth > row.clientWidth && !row.closest('.mobile-panel-overlay'));
    if (!crowded()) { row.removeAttribute('data-active-word'); return; }
    row.removeAttribute('data-words'); // not all on one line, or a word clipped in its tab: icons alone
    // the open tab still says its word when that fits (#9999): each tab is tried on its own (#10876) and a fit is marked
    const fit = tabs.map(b => { b.setAttribute('data-probe', ''); const ok = !crowded(); b.removeAttribute('data-probe'); b.toggleAttribute('data-word-ok', ok); return ok; });
    const fits = fit.some(Boolean);
    row.toggleAttribute('data-active-word', fits);
}

let lastShape = '';
/** Every tab stays in the row; only the row's width puts the LAST tabs under More (#21684). Writes only what changed (the startup sequence counts every write). */
function syncMore() {
    const row = strip(), more = $('agentic-tab-more');
    if (!row || !more) return;
    const tabsNow = [...row.querySelectorAll('.agentic-tab[data-tab]')]; // More is the last of the row: the page puts it there and the customizer places tabs before it
    const here = tabsNow.filter(shown), rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, tabW = Math.max(44, 1.125 * rootPx + 8); // an icon tab; the tabs stretch
    // places in the row after Customize (and close) and two kept free for the open tab's word and counts: constants, so placement follows the width alone
    const room = Math.floor((row.clientWidth - 5.5 * rootPx) / tabW) - [$('agentic-tab-customize'), $('agentic-mobile-close-btn')].filter(b => b?.offsetWidth).length;
    const keep = row.clientWidth > 0 && here.length > room ? Math.max(1, room - 1) : here.length; // More takes one place
    const left = here.slice(keep);
    for (const b of tabsNow) {
        const away = left.includes(b);
        if (b.classList.contains('tab-more') === away) continue;
        b.classList.toggle('tab-more', away);
        if (away) { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); b.removeAttribute('data-word-ok'); } // behind More: no word
        else { b.removeAttribute('tabindex'); b.removeAttribute('aria-hidden'); }
    }
    setHidden(more, !left.length);
    more.classList.toggle('active', left.some(b => b.classList.contains('active')));
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
    const r = more.getBoundingClientRect(); // the menu is fixed to the screen, under More
    menu.style.top = `${Math.round(r.bottom + 4)}px`; menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    more.setAttribute('aria-expanded', 'true');
    const items = [...menu.querySelectorAll('[role=menuitem]')];
    (first === 'last' ? items[items.length - 1] : items.find(i => i.classList.contains('active')) || items[0])?.focus();
}

/** After a pick the focus goes to the panel that opened, named for its tab (never body or a hidden item); a panel that cannot take it leaves the focus on More. */
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
    'dock-more-pick': el => { const t = el.dataset.tab; closeMore(false); if ($(`agentic-tab-${t}`)) { window.switchAgenticTab?.(t, 'top'); focusPanel(t); } },
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
        const ro = new ResizeObserver(() => { syncMore(); fitWords(); });
        ro.observe(row);
        for (const b of row.children) ro.observe(b); // a larger text size or a new count widens the tabs, not the row (#9435)
        watchScrollCue(row);
    } // the phone's overlay strip scrolls: a fade says which edge hides tabs
    document.addEventListener('click', e => { if (menuOpen && !e.target.closest?.('#agentic-more, #agentic-more-menu')) closeMore(false); });
    document.addEventListener('focusout', e => { if (menuOpen && e.relatedTarget && !e.relatedTarget.closest?.('#agentic-more, #agentic-more-menu')) closeMore(false); });
}
