/* The phone's ONE top bar (#11236, the operator's reference: the agent list's bar): ☰ on its own at the left, a borderless filled pill in the middle, the account avatar (with the hub's status dot) at the right.
 * Every top-level screen draws it from here, so the views cannot drift apart: Home puts its search in the pill, every other view puts its title in it (a heading, not a button: it has no title attribute, so no tooltip
 * lands on it). A drill-down has no ☰ and no avatar: its own bar (a ← and the title) is not this one. The look is css/mobile.css's `.phone-bar`; tests/frontend/phone_bar_browser.test.js measures every view's bar against Home's. */

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/** The bar. `pill` is the node that sits in the middle (Home's search row); without one the pill is the view's title (text set by setPhoneBarTitle). */
export function buildPhoneBar({ pill = null, id = '' } = {}) {
    const bar = el('div', 'phone-bar'); if (id) bar.id = id;
    const menu = el('button', 'btn btn-quiet btn-icon phone-menu-btn', '<span class="material-icons" aria-hidden="true">menu</span>');
    menu.type = 'button'; menu.setAttribute('data-on-click', 'm-top-menu'); menu.setAttribute('data-hamburger', ''); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', 'nav-more-menu'); menu.setAttribute('aria-label', 'Menu');
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
    header.prepend(buildPhoneBar({ id: 'top-phone-bar' }));
    setPhoneBarTitle(document.getElementById('top-menu-label')?.textContent || '');
}

/** The view's name in the pill (nav_tabs.js says it, with the tab's words). */
export function setPhoneBarTitle(words) {
    for (const t of document.querySelectorAll('.phone-bar-title')) t.textContent = words || '';
}
