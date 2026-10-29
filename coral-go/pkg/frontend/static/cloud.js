/* Cloud Hub integration: account menu, CSRF on state-changing requests, and
 * redirect-to-sign-in. Active only when the page's boot data says mode "cloud".
 *
 * Everything here builds DOM with textContent / properties (never innerHTML with
 * data) and registers its own listeners, so it works under a CSP without
 * 'unsafe-inline'. */

import { importOnce } from './import_once.js';
import { state } from './state.js';
import { isCloud, nativeInbox } from './server_base.js';
import { readAccount, accountNavEntries, ACCOUNT_NAV } from './account_info.js';
import { MENU_KEYS, menuMove } from './menu_keys.js';
import { filterSettingsPayload, settingsErrorMessage } from './cloud_settings.js';
import { signOutThisBrowser } from './local_store.js';
import { OUTCOME_UNKNOWN_LINE, isOutcomeUnknown } from './outcome_unknown.js';

/** GET paths that only a machine's own dashboard serves: privacy state and agent panels. (Themes,
 *  settings, tags, folder tags and views are the hub's own per-user data.) */
export const NO_HUB_ENDPOINT = /^\/api\/(system\/privacy|agent\/ui(\/.*)?)$/;

let _session = null;      // {authenticated, email, csrf}
let _loading = null;

/** Create an element: h('button', {className, onclick, dataset:{}}, ...children). */
export function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue;
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

/** Fetch (and cache) /auth/session. */
export function loadSession(force = false) {
    if (force) { _session = null; _loading = null; }
    if (_session) return Promise.resolve(_session);
    if (!_loading) {
        _loading = fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(r => (r.ok ? r.json() : { authenticated: false }))
            .catch(() => ({ authenticated: false }))
            .then(s => { _session = s; _loading = null; return s; });
    }
    return _loading;
}

/** The current CSRF token ('' until the session has loaded). */
 function csrfToken() { return (_session && _session.csrf) || ''; }

/** Where the sign-in page sends the user back to afterwards (same-origin path only). */
export function signInUrl() {
    const here = location.pathname + location.search;
    return '/signin' + (here && here !== '/' ? '?next=' + encodeURIComponent(here) : '');
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOrigin(input) {
    try {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        return u.origin === location.origin;
    } catch { return false; }
}

function settingsPath(input) {
    try { return new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href).pathname; } catch { return ''; }
}

/** Tell the user why the hub refused a settings or theme write (400/413 JSON bodies). */
function explainSettingsRefusal(resp) {
    if (!/json/i.test(resp.headers.get('Content-Type') || '')) return;
    resp.clone().json().then(async body => {
        const msg = settingsErrorMessage(resp.status, body);
        if (!msg) return;
        const { showToast } = await importOnce('./utils.js');
        showToast(msg, true, 8000);
    }).catch(() => {});
}

let _lastExplained = 0;
/** Tell the user why the hub or their machine refused a request (JSON 403 bodies only), once per few seconds. */
function explainRefusal(resp) {
    if (Date.now() - _lastExplained < 3000) return;
    // A launch says its own refusal, with the machine's name (launch_server.js): one toast, not two (#4586).
    if (/\/api\/sessions\/launch(-team)?$/.test(settingsPath(resp.url || ''))) return;
    if (!/json/i.test(resp.headers.get('Content-Type') || '')) return;
    resp.clone().json().then(async body => {
        const { refusalMessage } = await importOnce('./server_access.js');
        const msg = refusalMessage(resp.status, body);
        if (!msg) return;
        _lastExplained = Date.now();
        const { showToast } = await importOnce('./utils.js');
        showToast(msg, true, 8000);
    }).catch(() => {});
}

// A reply the computer refused to send because it is too large to check for secrets through
// Coral Hub (#3718: a JSON reply over 2 MiB). Whatever view asked, the user is told why it is
// empty instead of seeing a blank pane: the dashboard pages what can be that big (history, the
// board export), so this is a rare reply, and one toast at a time says it.
let _lastTooLarge = 0;
function explainTooLarge(resp) {
    if (!/json/i.test(resp.headers.get('Content-Type') || '')) return;
    resp.clone().json().then(async body => {
        if (!body || body.code !== 'hub_reply_too_large' || Date.now() - _lastTooLarge < 5000) return;
        _lastTooLarge = Date.now();
        const { showToast } = await importOnce('./utils.js');
        showToast('This is too large to show through Coral Hub; open it on the computer.', true, 8000);
    }).catch(() => {});
}

/** A write the hub could not finish telling (502 outcome_unknown, #6342): the same response with its words replaced by the one line, so a path that shows the server's words shows that line and not a hint to send it again.
 *  Returns null for any other 502 and for a launch. */
async function sayOutcomeUnknown(resp, url) {
    if (!/json/i.test(resp.headers.get('Content-Type') || '')) return null;
    let body = null;
    try { body = await resp.clone().json(); } catch { return null; }
    if (!isOutcomeUnknown(resp.status, body, url || resp.url)) return null;
    return new Response(JSON.stringify({ ...body, code: 'outcome_unknown', error: OUTCOME_UNKNOWN_LINE }), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

/** Wrap window.fetch: add X-CSRF-Token on same-origin state-changing calls and
 *  send the user to sign-in when the session has ended. */
export function installCloudFetch() {
    if (window.__coralCloudFetch) return;
    window.__coralCloudFetch = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        // Endpoints that exist only on a machine's own dashboard are not reachable through the hub
        // (and the hub has no stand-in). Answer them locally with a 404 instead of sending a request
        // that can only fail, which would put a network error in the console on every page load.
        if (sameOrigin(input)) {
            const p = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href).pathname;
            // '/api/cloud-unavailable' is where server_base.serverUrl() points a machine-only route (settings, privacy, ...)
            // so it fails cleanly; any method, never sent.
            if (p === '/api/cloud-unavailable' || (method === 'GET' && NO_HUB_ENDPOINT.test(p))) {
                return new Response('{"error":"not available through the hub"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
            }
        }
        // The hub stores only per-user keys and refuses a whole /api/settings write that has any other key, so the
        // machine-local keys other callers still include (terminal size, CLI paths, ...) are dropped here.
        if (method === 'PUT' && sameOrigin(input) && settingsPath(input) === '/api/settings' && init && typeof init.body === 'string') {
            try {
                const { kept, dropped } = filterSettingsPayload(JSON.parse(init.body));
                if (dropped.length) {
                    console.debug('[coral] settings kept on the machine, not sent to the hub:', dropped.join(', '));
                    if (!Object.keys(kept).length) return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
                    init = { ...init, body: JSON.stringify(kept) };
                }
            } catch { /* not JSON: let the hub answer */ }
        }
        if (!SAFE.has(method) && sameOrigin(input)) {
            if (!csrfToken()) await loadSession();
            const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
            if (csrfToken()) headers.set('X-CSRF-Token', csrfToken());
            init = { ...(init || {}), headers, credentials: 'same-origin' };
        }
        const resp = await orig(input, init);
        if (resp.status === 403 && !SAFE.has(method)) _session = null; // token may have rotated; refetch next time
        if (resp.status === 502 && sameOrigin(input)) explainTooLarge(resp);
        if (resp.status === 502 && !SAFE.has(method) && sameOrigin(input)) { const said = await sayOutcomeUnknown(resp, typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || ''); if (said) return said; }
        // `quiet: true` marks a background request the user did not ask for (e.g. fitting the pane width on open):
        // a refusal there is not worth a toast, only an action the user took is.
        if (resp.status === 403 && sameOrigin(input) && !(init && init.quiet)) explainRefusal(resp);
        if ((resp.status === 400 || resp.status === 413) && method === 'PUT' && sameOrigin(input) && /^\/api\/(settings$|themes\/)/.test(settingsPath(input))) explainSettingsRefusal(resp);
        if (resp.status === 401 && sameOrigin(input) && !/^\/(signin|auth|enroll)/.test(location.pathname)) {
            location.replace(signInUrl());
        }
        return resp;
    };
}

const signOut = signOutThisBrowser; // drafts, pending messages, recent folders, stars and panel requests go before the session does (#3681, #4164)

const navLink = ([text, href]) => h('a', { className: 'menu-item overflow-menu-item', role: 'menuitem', href, text, ...(href === '/usage' ? { id: 'cloud-account-usage' } : {}) });

function buildAccountMenu(email) {
    // The hub's own pages, on this origin (the dashboard is served by the hub): plain links, same tab. Until the account answers (and for an older Hub, or a failed read) the entries are Account (coral-go#1) and Saved for later (the hub's roll-up of every machine's saved messages, #4596).
    const defaults = [navLink(ACCOUNT_NAV.account), navLink(ACCOUNT_NAV.saved)];
    const signOutBtn = h('button', { type: 'button', className: 'menu-item overflow-menu-item', role: 'menuitem', text: 'Sign out', onclick: signOut });
    const menu = h('div', { className: 'menu cloud-account-menu', id: 'cloud-account-menu', hidden: true, role: 'menu' },
        h('div', { className: 'cloud-account-email', text: email, title: email }),
        h('button', { type: 'button', className: 'menu-item overflow-menu-item', role: 'menuitem', text: 'Servers', onclick: () => { setOpen(false); importOnce('./servers.js', 'the server list').then(m => m.showServersModal(), () => {}); } }),
        ...defaults, signOutBtn,
    );
    const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
    const setOpen = (open, focus = true) => {
        menu.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) items()[0]?.focus(); // opened: the focus lands on the first item
        else if (focus && menu.contains(document.activeElement)) btn.focus(); // closed from inside: back to the button
    };
    const btn = h('button', {
        type: 'button', className: 'btn btn-quiet btn-icon btn-small top-bar-btn cloud-account-btn', title: email, 'aria-label': 'Account menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: e => { e.stopPropagation(); setOpen(menu.hidden); },
    }, h('span', { className: 'material-icons top-bar-icon', 'aria-hidden': 'true', text: 'account_circle' }));
    document.addEventListener('click', () => setOpen(false, false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); } });
    menu.addEventListener('keydown', e => { // the one menu keyboard (menu_keys.js): Up and Down wrap, Home and End
        if (!MENU_KEYS.has(e.key)) return;
        const list = items(), to = menuMove(e.key, list.length, list.indexOf(document.activeElement));
        if (to < 0) return;
        e.preventDefault(); list[to].focus();
    });
    btn.addEventListener('keydown', e => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) { e.preventDefault(); setOpen(true); } });
    // What the Hub says this account may use: one read of /api/account for the page (account_info.js). A failed read, or an answer with no `nav`, changes nothing.
    readAccount().then(d => {
        const entries = accountNavEntries(d && d.nav);
        if (entries) { defaults.forEach(a => a.remove()); signOutBtn.before(...entries.map(navLink)); return; }
        if (d && d.analytics_tab === true) defaults[1].after(navLink(ACCOUNT_NAV.usage)); // an older Hub that names no `nav` but has the rolled-up Analytics (#11018): Usage after Saved for later, as before
    });
    return h('div', { className: 'cloud-account-wrapper' }, btn, menu);
}

/** Start cloud mode. Resolves true when signed in; otherwise redirects to sign-in. */
export async function initCloud() {
    if (!isCloud()) return false;
    document.body.classList.add('cloud-mode');
    if (nativeInbox()) document.body.classList.add('native-inbox'); // the Chats and Board tabs are data-native-inbox-hides (cloud.css, nav_tabs.js)
    state.cloud = true;
    state.hub = true;
    installCloudFetch();
    const s = await loadSession();
    if (!s.authenticated) { location.replace(signInUrl()); return false; }
    state.account = { email: s.email };
    const actions = document.querySelector('.top-bar-actions');
    if (actions && !document.getElementById('cloud-account-menu')) actions.append(buildAccountMenu(s.email));
    importOnce('./artifacts_tab.js').then(m => m.initArtifactsTab()).catch(() => {}); // not waited for: the Artifacts tab appears when the account says it has one (#6236)
    importOnce('./team_link_flag.js').then(m => m.initTeamLinkFlag()).catch(() => {}); // not waited for: "Link team..." appears in a team's menu when the account says so (#9888)
    return true;
}
