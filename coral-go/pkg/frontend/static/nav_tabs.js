/* The top navigation at every width (#3816). The tab buttons in the top bar are the one list; this module draws the rest from
 * them, so a tab that appears or goes (Servers, Board, the Hub's local-only tabs) and the active tab follow:
 *  - Desktop and tablet: the tabs stay in one row with their normal gap, never wrapped or squeezed together. When they do not
 *    all fit (large text, zoom, more tabs) the last ones (never the active one) move under a "More" menu in the top bar.
 *  - Phone (<= 767 px): the row is replaced by one current-view dropdown in the top bar (44 px tall): it names the view you are
 *    on and opens the list of all views. Escape and a click outside close it.
 * - Under 640 px (#9021) the top row is one hamburger button: it names the view and opens the views, then Home, Settings (themes, servers, updates) and the account.
 * The buttons drawn here carry the same data-on-click as the tabs, so switching a tab is still the one action. */
import { PHONE_QUERY } from './phone_layout.js';
import { registerActions } from './actions.js';
import { isHub } from './server_base.js';
import { MENU_KEYS, menuMove } from './menu_keys.js';

const ICONS = { agents: 'smart_toy', history: 'chat_bubble_outline', workflows: 'account_tree', jobs: 'schedule', automations: 'schedule', tokens: 'insights',
    docs: 'menu_book', servers: 'dns', 'hub-inbox': 'notifications', board: 'forum', artifacts: 'inventory_2' };

const tabsEl = () => document.querySelector('.top-nav-tabs');
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/** The tabs that exist right now, in order: {id, arg, label, active, el}. */
function availableTabs() {
    const cloud = document.body.classList.contains('cloud-mode'), nativeInbox = document.body.classList.contains('native-inbox');
    return [...document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')]
        .filter(el => !el.hidden && el.style.display !== 'none' && !(cloud && el.hasAttribute('data-local-only')) && !(nativeInbox && el.hasAttribute('data-native-inbox-hides')) && !(!cloud && el.hasAttribute('data-cloud-only')))
        .map(el => ({ id: el.id, arg: el.dataset.arg, label: (el.dataset.label || el.textContent).trim(), active: el.classList.contains('active'), el }));
}

// Built with the DOM, so no text from a tab is ever read as markup.
function makeItem(t) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item nav-more-item' + (t.active ? ' active' : '');
    b.dataset.onClick = 'm-switch-nav-tab';
    b.dataset.arg = t.arg;
    if (t.active) b.setAttribute('aria-current', 'page');
    const i = document.createElement('span');
    i.className = 'material-icons';
    i.setAttribute('aria-hidden', 'true');
    i.textContent = ICONS[t.arg] || 'circle';
    const l = document.createElement('span');
    l.textContent = t.label;
    b.append(i, l);
    // A tab with a count (the Inbox's waiting number) shows it in the list too, and the item says it (#4718).
    const badge = t.el.querySelector('.nav-tab-badge');
    if (badge && !badge.hidden && badge.textContent) {
        const c = document.createElement('span');
        c.className = 'chip chip-count nav-tab-badge nav-more-badge';
        c.textContent = badge.textContent;
        b.append(c);
        b.setAttribute('aria-label', t.el.getAttribute('aria-label') || `${t.label}, ${badge.textContent}`);
    }
    return b;
}

function makeMore() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab top-nav-tab nav-more-btn';
    b.dataset.onClick = 'm-nav-more';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', 'nav-more-menu');
    const t = document.createElement('span');
    t.textContent = 'More';
    const c = document.createElement('span');
    c.className = 'material-icons';
    c.setAttribute('aria-hidden', 'true');
    c.textContent = 'expand_more';
    b.append(t, c);
    return b;
}

/** One entry of the hamburger menu, built with the DOM: an action (the same data-on-click as the control it stands for) or a link. */
function entry(icon, label, { action, href, onClick } = {}) {
    const b = document.createElement(href ? 'a' : 'button');
    if (href) b.href = href; else b.type = 'button';
    b.className = 'menu-item nav-more-item';
    b.setAttribute('role', 'menuitem');
    if (action) b.dataset.onClick = action;
    if (onClick) b.addEventListener('click', onClick);
    const i = document.createElement('span');
    i.setAttribute('aria-hidden', 'true');
    if (icon instanceof Element) { i.className = 'nav-more-drawn'; i.append(icon); } // a drawn icon (the Saved folder's bookmark): the icon font has no glyph for it (#9160)
    else { i.className = 'material-icons'; i.textContent = icon; }
    const l = document.createElement('span');
    l.textContent = label;
    b.append(i, l);
    return b;
}

/** What the gear and the account buttons hold, as entries (#9021): the settings, the themes, the update check, the servers; on the Hub the account's pages and Sign out, by clicking the account menu's own items. */
function menuEntries(viewLabels = new Set()) {
    const cloud = document.body.classList.contains('cloud-mode');
    const out = [entry('home', 'Home', { action: 'm-go-home' })];
    out.push(entry('settings', 'Settings', { action: 'm-close-top-bar-settings-then-show-settings-modal' }), entry('palette', 'Themes', { action: 'm-close-top-bar-settings-then-show-theme-configurator' }));
    if (!cloud) out.push(entry('system_update', 'Check for updates', { action: 'm-close-top-bar-settings-then-check-for-updates' }));
    if ((isHub() || cloud) && !viewLabels.has('Servers')) out.push(entry('dns', 'Servers', { action: 'm-close-top-bar-settings-then-show-servers-modal' })); // not twice: when the Servers view is one of the views above, two entries are named alike
    const account = document.getElementById('cloud-account-menu');
    if (account) for (const item of account.querySelectorAll('a.overflow-menu-item, button.overflow-menu-item')) {
        const label = item.textContent.trim();
        if (label === 'Servers') continue; // already above
        out.push(entry(label === 'Sign out' ? 'lock' : label === 'Account' ? 'account_circle' : 'open_in_new', label, { onClick: () => item.click() })); // the account menu's own handler, so Sign out clears the drafts first
    }
    return out;
}

let _more = [];          // the tabs the row's More menu lists right now
let _menuFor = null;     // the button that opened the menu

function closeMenu() {
    const menu = document.getElementById('nav-more-menu');
    if (menu) menu.hidden = true;
    document.querySelectorAll('[data-on-click="m-nav-more"], [data-on-click="m-top-menu"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    _menuFor = null;
}

function openMenu(btn) {
    const menu = document.getElementById('nav-more-menu');
    if (!menu) return;
    const hamburger = btn.id === 'top-menu-btn' || btn.hasAttribute('data-hamburger'); // the agent row's menu button is the same menu (#11056)
    const all = hamburger || btn.hasAttribute('data-nav-all');
    const items = all ? availableTabs() : _more;
    if (!items.length) return;
    menu.classList.toggle('nav-all', all);
    menu.classList.toggle('nav-hamburger', hamburger);
    if (hamburger) {
        const sep = document.createElement('div'); sep.className = 'nav-more-sep'; sep.setAttribute('role', 'separator');
        menu.replaceChildren(...items.map(makeItem), sep, ...menuEntries(new Set(items.map(t => t.label))));
        for (const v of menu.querySelectorAll('.nav-more-item:not([role])')) v.setAttribute('role', 'menuitem');
    } else menu.replaceChildren(...items.map(makeItem));
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.bottom = 'auto';
    menu.style.maxHeight = Math.max(120, window.innerHeight - Math.round(r.bottom + 6) - 8) + 'px'; // never taller than the room under its button: on a short phone the last item (Sign out) was 30 px off the screen (#10767); .nav-more-menu scrolls
    if (all) { menu.style.left = '8px'; menu.style.right = '8px'; }
    else { menu.style.left = 'auto'; menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px'; }
    btn.setAttribute('aria-expanded', 'true');
    _menuFor = btn;
}

// Desktop and tablet: show every tab, then take tabs off the end (not the active one) until the row fits.
function layoutRow() {
    const nav = tabsEl();
    if (!nav) return;
    const all = availableTabs();
    nav.querySelectorAll('.nav-more-wrap').forEach(n => n.remove());
    for (const t of all) t.el.classList.remove('nav-overflowed');
    _more = [];
    if (isPhone()) return;
    const fits = () => nav.scrollWidth <= nav.clientWidth + 1;
    if (fits()) return;
    const wrap = document.createElement('span');
    wrap.className = 'nav-more-wrap';
    const btn = makeMore();
    wrap.appendChild(btn);
    nav.appendChild(wrap);
    for (const t of all.filter(x => !x.active).reverse()) {
        if (fits()) break;
        t.el.classList.add('nav-overflowed');
        _more.unshift(t);
    }
    if (!_more.length) wrap.remove();
    else if (_more.some(t => t.active)) btn.classList.add('active');
}

// Phone: the dropdown names the current view.
function layoutSelect() {
    const label = document.getElementById('nav-select-label');
    if (!label) return;
    const cur = availableTabs().find(t => t.active);
    const hiddenOn = cur ? null : document.querySelector('.top-nav-tabs > .top-nav-tab.active[data-arg]'); // a view whose tab is not in the bar (Servers on a local Coral's hub page) is still the view on screen: the bar names it, never blank (#9683)
    const words = cur ? cur.label : (hiddenOn ? (hiddenOn.dataset.label || hiddenOn.textContent).trim() : '');
    label.textContent = words;
    const top = document.getElementById('top-menu-label'); if (top) top.textContent = words;
    for (const hamburger of [document.getElementById('top-menu-btn'), document.getElementById('agent-bar-menu')]) { // the top bar's and, under 640 px while an agent is open, the agent row's (#11056): one menu, one name
    if (hamburger) {
        // What waits for the person is the Inbox tab's own name ("Inbox, 3 waiting for input", set by inbox_tab.js): the closed bar shows a dot for it and the button's name says it in the same words (#9829)
        const waits = ((document.getElementById('nav-tab-hub-inbox') || {}).getAttribute?.('aria-label') || '').replace(/^Inbox, /, '');
        hamburger.setAttribute('aria-label', (words ? `${words}, menu` : 'Menu') + (waits ? `, ${waits}` : '')); // its name has the words it shows: the open view first (#9116)
        if (hamburger.hasAttribute('data-waiting') !== !!waits) hamburger.toggleAttribute('data-waiting', !!waits);
    }
    }
    if (_menuFor && (_menuFor.id === 'nav-select' && !isPhone() || (_menuFor.id === 'top-menu-btn' || _menuFor.id === 'agent-bar-menu') && !window.matchMedia('(max-width: 639px)').matches)) closeMenu();
}

let _scheduled = 0;
let _obs = null;
function syncNav() {
    cancelAnimationFrame(_scheduled);
    _scheduled = requestAnimationFrame(() => {
        layoutRow(); layoutSelect();
        if (_obs) _obs.takeRecords(); // what this redraw changed is not a reason to redraw
    });
}

registerActions({
    'm-top-menu': (el, event) => {
        event.stopPropagation();
        if (_menuFor === el) { closeMenu(); return; }
        closeMenu(); openMenu(el);
        if (event.detail === 0) document.querySelector('#nav-more-menu .nav-more-item')?.focus(); // opened by the keyboard (Enter or Space): the focus goes to the first item, as the Settings menu's did; Escape gives it back to the button
    },
    'm-nav-more': (el, event) => {
        event.stopPropagation();
        if (_menuFor === el) closeMenu(); else { closeMenu(); openMenu(el); }
    },
});

if (typeof document !== 'undefined') {
    const init = () => {
        const nav = tabsEl();
        if (!nav) return;
        const bar = document.querySelector('header.top-bar');
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(syncNav);
            ro.observe(bar);
            for (const t of nav.querySelectorAll('.top-nav-tab')) ro.observe(t); // a change of text size widens the tabs and leaves the bar's height as it was (a tab is 40 px, not as high as its text): the row is laid out again
        }
        // A tab appears or goes, or the active tab changes: redraw from the tabs.
        _obs = new MutationObserver(syncNav);
        _obs.observe(nav, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden', 'style', 'aria-current'] });
        window.addEventListener('resize', syncNav);
        window.matchMedia(PHONE_QUERY).addEventListener('change', syncNav);
        window.matchMedia('(max-width: 639px)').addEventListener('change', syncNav);
        document.addEventListener('click', e => {
            if (!_menuFor) return;
            if (e.target.closest('#nav-more-menu .nav-more-item')) {
                const button = _menuFor; closeMenu();
                const a = document.activeElement; // a choice gives the focus back to the button, unless what it opened (a dialog) has taken it (#9116)
                if (button && (!a || a === document.body || !a.getClientRects().length)) button.focus(); // (a view's own switch may have focused a control the phone does not draw: the dropdown or a tab)
                // the agent row's menu button goes with the agent's page when the view changes: the top bar's takes the focus then (#11056)
                if (button && button.id === 'agent-bar-menu') setTimeout(() => { if (!button.getClientRects().length && (!document.activeElement || document.activeElement === document.body)) document.getElementById('top-menu-btn')?.focus(); }, 0);
            } else if (!e.target.closest('#nav-more-menu, [data-on-click="m-nav-more"], [data-on-click="m-top-menu"]')) closeMenu();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _menuFor) { const b = _menuFor; closeMenu(); b.focus(); return; }
            if (!MENU_KEYS.has(e.key)) return;
            // the menu keyboard (#9116, one function: menu_keys.js): the arrows and Home/End move among the entries; on the button, ArrowDown and ArrowUp open the menu on its first or last entry
            const menu = document.getElementById('nav-more-menu');
            const entries = () => [...(menu ? menu.querySelectorAll('.nav-more-item') : [])].filter(x => x.getClientRects().length);
            if (menu && !menu.hidden && menu.contains(e.target)) {
                const items = entries(), at = items.indexOf(document.activeElement);
                if (!items.length) return;
                e.preventDefault();
                items[menuMove(e.key, items.length, at)].focus();
                return;
            }
            const button = e.target.closest?.('[data-on-click="m-top-menu"], [data-on-click="m-nav-more"]');
            if (!button || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
            e.preventDefault();
            if (_menuFor !== button) { closeMenu(); openMenu(button); }
            const items = entries();
            items[menuMove(e.key, items.length, -1)]?.focus();
        });
        syncNav();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
