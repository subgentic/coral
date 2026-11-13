/* Shared phone header: navigation, left-aligned title, one account action, then
 * the view's search on its own row (#15859). Drill-downs keep their own back handlers. */

import { isPhoneBar } from './phone_layout.js';
import { importOnce } from './import_once.js';
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/** Shared header; `pill` is the Agents search row kept below it for existing callers. */
export function buildPhoneBar({ pill = null, id = '', menuId = '' } = {}) {
    const bar = el('div', 'phone-bar'); if (id) bar.id = id;
    const menu = el('button', 'btn btn-quiet btn-icon phone-menu-btn', '<span class="material-icons" aria-hidden="true">menu</span>');
    menu.type = 'button'; menu.setAttribute('data-on-click', 'm-top-menu'); menu.setAttribute('data-hamburger', ''); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', 'nav-more-menu'); menu.setAttribute('aria-label', 'Menu');
    menu.setAttribute('data-coral-hook', 'phone-menu-button'); if (menuId) menu.id = menuId;
    const mid = el('h1', 'phone-bar-title phone-bar-pill');
    if (pill) mid.textContent = 'Agents';
    const account = el('button', 'phone-account-btn', '<span class="material-icons" aria-hidden="true">account_circle</span><span class="sr-only phone-hub-state"></span>');
    account.type = 'button'; account.setAttribute('data-on-click', 'm-top-menu'); account.setAttribute('data-hamburger', ''); account.setAttribute('data-account', ''); account.setAttribute('aria-haspopup', 'menu'); account.setAttribute('aria-expanded', 'false'); account.setAttribute('aria-controls', 'nav-more-menu'); account.setAttribute('aria-label', 'Settings and account'); account.title = 'Settings and account'; // the name the a11y pass gave the avatar (#11281)
    bar.append(menu, mid, account);
    if (pill) { pill.classList.add('phone-bar-search-row'); bar.append(pill); }
    return bar;
}

/** The page's own bar, in header.top-bar (drawn only on a phone, css/mobile.css): built once. */
export function mountTopPhoneBar() {
    const header = document.querySelector('header.top-bar');
    if (!header || header.querySelector(':scope > .phone-bar')) return;
    header.prepend(buildPhoneBar({ id: 'top-phone-bar', menuId: 'top-phone-menu' }));
    setPhoneBarTitle(document.getElementById('top-menu-label')?.textContent || '');
    watchPageHeading();
}

/** The view's name in the header (nav_tabs.js says it, with the tab's words). A page that is not one of the nav's tabs (Tasks, Goals and Files from Home are a folder's table, a team page's tabs) has none: the header then says the page's own heading, so it is never empty (QA Reviewer 2's nit on #137846). */
export function setPhoneBarTitle(words) {
    _lastWords = words || '';
    _named = !!words;
    paintTitle(_pageName || words || pageHeading());
}

/** The search each top-level view has in the sidebar (hidden on a phone): the header has a separate search row for it (#11476, Gmail's "Search in mail"). It types into that field, so the view filters as it does anywhere. */
export const repaintPhoneBarSearch = () => paintTitle(_pageName || _lastWords || pageHeading());
let searchWords = '';
function paintTitle(words) {
    searchWords = words;
    const inbox = document.querySelector('.top-nav-tab.active')?.dataset.arg === 'hub-inbox';
    for (const t of document.querySelectorAll('.phone-bar-title')) {
        const bar = t.closest('.phone-bar');
        bar.classList.toggle('phone-inbox-bar', inbox);
        if (bar.closest('#mobile-agent-list')) { t.textContent = 'Agents'; continue; }
        let txt = t.querySelector('.phone-bar-title-text');
        if (!txt) { txt = document.createElement('span'); txt.className = 'phone-bar-title-text'; t.replaceChildren(txt); }
        const title = inbox ? (pageHeading() || 'Inbox') : words;
        if (txt.textContent !== title) txt.textContent = title;
    }
    if (isPhoneBar()) importOnce('./phone_bar_search.js').then(m => m.paintPhoneSearch(searchWords)).catch(e => console.warn('[coral] phone search could not load', e));
}
let _named = false, _lastWords = '', _prevSlot = '';
/** A page the bar's own buttons open inside another view (its Tasks is the Inbox view's Tasks table, #11401): the header says that page's name, whatever the nav's refreshes put for the view, until another tab is chosen (clearPhonePageName, switchNavTab). */
let _pageName = '';
const lightSlot = name => { for (const it of document.querySelectorAll('.phone-nav-slot[data-phone-nav]')) { const on = it.dataset.phoneNav === name; it.classList.toggle('active', on); if (on) it.setAttribute('aria-current', 'page'); else it.removeAttribute('aria-current'); } };
export function setPhonePageName(name) {
    if (!_pageName) _prevSlot = document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav || ''; // the slot the page replaces, for when it is over
    _pageName = name || '';
    if (_pageName) { document.body.dataset.phonePage = _pageName; paintTitle(_pageName); } // phone_screens.js reads it for the lit slot
    if (_pageName === 'Tasks') lightSlot('nav-inbox'); // an Inbox page: its folder, so the Inbox tab stays lit
    if (_pageName === 'Chats') lightSlot('menu'); // no bar slot: the drawer's
}
/** The page is over (another tab was chosen, or the Inbox's own tab is no longer Tasks): the header says the view's name again and the slot the page replaced is lit. */
export function clearPhonePageName(keep = '') {
    const had = _pageName;
    if (keep && had.toLowerCase() === keep) return; // the Inbox's own tab is the page the bar opened (Tasks, Chats): it stays
    _pageName = ''; delete document.body.dataset.phonePage;
    if (!had) return;
    paintTitle(_lastWords || pageHeading());
    if (_prevSlot) lightSlot(_prevSlot);
}
function pageHeading() {
    const h = ['#group-table-view .group-table-head h2', '#group-table-view h2', '#team-page-title', '#servers-tab-title', 'main h1'].map(sel => [...document.querySelectorAll(sel)].find(e => e.getClientRects().length > 0 && e.textContent.trim())).find(Boolean);
    return h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
}
/** A table's heading is drawn after the view switches: the header follows it while the nav has no word of its own. */
export function watchPageHeading() {
    const host = document.getElementById('group-table-view');
    if (!host || host._phoneBarWatched) return;
    host._phoneBarWatched = true;
    let queued = 0;
    new MutationObserver(() => { if (!_named) setPhoneBarTitle(''); if (!queued) queued = requestAnimationFrame(() => { queued = 0; if (document.querySelector('.top-nav-tab.active')?.dataset.arg === 'hub-inbox') repaintPhoneBarSearch(); }); }).observe(host, { childList: true, subtree: true }); // an Inbox page is drawn after the tab: the search row takes its search
}
