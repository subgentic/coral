/* The phone's ONE top bar (#11236, the operator's reference: the agent list's bar): ☰ on its own at the left, a borderless filled pill in the middle, the account avatar (with the hub's status dot) at the right.
 * Every top-level screen draws it from here, so the views cannot drift apart: Home puts its search in the pill, every other view puts its title in it (a heading, not a button: it has no title attribute, so no tooltip
 * lands on it). A drill-down has no ☰ and no avatar: its own bar (a ← and the title) is not this one. The look is css/mobile.css's `.phone-bar`; tests/frontend/phone_bar_browser.test.js measures every view's bar against Home's. */

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/** The bar. `pill` is the node that sits in the middle (Home's search row); without one the pill is the view's title (text set by setPhoneBarTitle). */
export function buildPhoneBar({ pill = null, id = '', menuId = '' } = {}) {
    const bar = el('div', 'phone-bar'); if (id) bar.id = id;
    const menu = el('button', 'btn btn-quiet btn-icon phone-menu-btn', '<span class="material-icons" aria-hidden="true">menu</span>');
    menu.type = 'button'; menu.setAttribute('data-on-click', 'm-top-menu'); menu.setAttribute('data-hamburger', ''); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', 'nav-more-menu'); menu.setAttribute('aria-label', 'Menu');
    if (menuId) menu.id = menuId;
    let mid = pill;
    if (!mid) { mid = el('h1', 'phone-bar-title'); }
    mid.classList.add('phone-bar-pill');
    const account = el('button', 'phone-account-btn', '<span class="material-icons" aria-hidden="true">account_circle</span><span class="sr-only phone-hub-state"></span>');
    account.type = 'button'; account.setAttribute('data-on-click', 'm-top-menu'); account.setAttribute('data-hamburger', ''); account.setAttribute('data-account', ''); account.setAttribute('aria-haspopup', 'menu'); account.setAttribute('aria-expanded', 'false'); account.setAttribute('aria-controls', 'nav-more-menu'); account.setAttribute('aria-label', 'Settings and account'); account.title = 'Settings and account'; // the name the a11y pass gave the avatar (#11281)
    bar.append(menu, mid, account);
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

/** The view's name in the pill (nav_tabs.js says it, with the tab's words). A page that is not one of the nav's tabs (Tasks, Goals and Files from Home are a folder's table, a team page's tabs) has none: the pill then says the page's own heading, so it is never empty (QA Reviewer 2's nit on #137846). */
export function setPhoneBarTitle(words) {
    _lastWords = words || '';
    _named = !!words;
    paintTitle(_pageName || words || pageHeading());
}

/** The search each top-level view has in the sidebar (hidden on a phone): the bar's pill is a search field for it (#11476, Gmail's "Search in mail"). It types into that field, so the view filters as it does anywhere. */
const SEARCH_OF = { 'hub-inbox': 'inbox-search', history: 'history-search', automations: 'automations-search', tokens: 'analytics-search', docs: 'docs-search' };
const searchTarget = () => { const id = SEARCH_OF[document.querySelector('.top-nav-tab.active')?.dataset.arg || '']; return id ? document.getElementById(id) : null; };

/** The title in every bar's pill, and where the view has a search, the field in it: the title stays for a screen reader and the field's placeholder says what it searches. */
function paintTitle(words) {
    for (const t of document.querySelectorAll('.phone-bar-title')) {
        let txt = t.querySelector('.phone-bar-title-text');
        if (!txt) { txt = document.createElement('span'); txt.className = 'phone-bar-title-text'; t.replaceChildren(txt); }
        if (txt.textContent !== words) txt.textContent = words;
        const target = searchTarget();
        let input = t.querySelector('.phone-bar-search');
        if (!target) { input?.remove(); continue; }
        if (!input) {
            input = document.createElement('input'); input.type = 'search'; input.className = 'phone-bar-search'; input.autocomplete = 'off'; input.enterKeyHint = 'search';
            input.addEventListener('input', () => { const to = searchTarget(); if (to && to.value !== input.value) { to.value = input.value; to.dispatchEvent(new Event('input', { bubbles: true })); } });
            t.append(input);
        }
        const label = `Search ${words}`;
        if (input.placeholder !== label) { input.placeholder = label; input.setAttribute('aria-label', label); }
        if (input._for !== target.id) { input._for = target.id; input.value = target.value; } // another view's search: its own words, even while the field has the focus
        else if (document.activeElement !== input && input.value !== target.value) input.value = target.value; // the view's own search words, kept when the tab is left and come back to
    }
}
let _named = false, _lastWords = '', _prevSlot = '';
/** A page the bar's own buttons open inside another view (its Tasks is the Inbox view's Tasks table, #11401): the pill says that page's name, whatever the nav's refreshes put for the view, until another tab is chosen (clearPhonePageName, switchNavTab). */
let _pageName = '';
const lightSlot = name => { for (const it of document.querySelectorAll('.phone-nav-slot[data-phone-nav]')) { const on = it.dataset.phoneNav === name; it.classList.toggle('active', on); if (on) it.setAttribute('aria-current', 'page'); else it.removeAttribute('aria-current'); } };
export function setPhonePageName(name) {
    if (!_pageName) _prevSlot = document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav || ''; // the slot the page replaces, for when it is over
    _pageName = name || '';
    if (_pageName) { document.body.dataset.phonePage = _pageName; paintTitle(_pageName); } // phone_screens.js reads it for the lit slot
    if (_pageName === 'Tasks') lightSlot('nav-tasks');
    if (_pageName === 'Chats') lightSlot('nav-chats');
}
/** The page is over (another tab was chosen, or the Inbox's own tab is no longer Tasks): the pill says the view's name again and the slot the page replaced is lit. */
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
/** A table's heading is drawn after the view switches: the pill follows it while the nav has no word of its own. */
export function watchPageHeading() {
    const host = document.getElementById('group-table-view');
    if (!host || host._phoneBarWatched) return;
    host._phoneBarWatched = true;
    new MutationObserver(() => { if (!_named) setPhoneBarTitle(''); }).observe(host, { childList: true, subtree: true });
}
