/* Save for Later (#4510), the buttons on messages: a bookmark button on each message of an agent's Chat view (live or in History) and of a board, filled when
 * the message is saved. The Saved list and the jump back are in saved.js, which loads when the list is opened. Bookmarks live on the server that has the conversation (the
 * Operator's own, GET/POST/PATCH/DELETE /api/saved there): this server's, or a registered remote server's through the hub's proxy (#4551, serverFetch). */
import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { showToast, escapeAttr } from './utils.js';
import { isCloud, sessionServer, normServer, splitKey, serverFetch, LOCAL_SERVER } from './server_base.js';
import { dockKind, onDockPage } from './dock_page.js';
import { scopeOf, withScope, ALL } from './saved_scope.js';
import { setInboxCount } from './inbox_tab.js'; // the count on the Inbox's Saved tab

// The bookmark is an inline SVG (the shape the Team Artifacts' Keep button uses), filled when saved: the Material Icons subset has no bookmark.
const BOOKMARK_SVG = '<svg class="bm" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8v11L8 10.5l-4 3z"/></svg>';
export const SAVE_BUTTON = `<button type="button" class="btn btn-quiet btn-icon btn-xs chat-save-btn" title="Save for later" aria-label="Save for later" aria-pressed="false">${BOOKMARK_SVG}</button>`;
export const BOARD_SAVE_BUTTON = (ref, title, said, author = '') => `<button type="button" class="btn btn-quiet btn-icon btn-xs mb-save-btn" data-conv-ref="${escapeAttr(ref)}" data-conv-title="${escapeAttr(title)}" data-said="${escapeAttr(said)}" data-author="${escapeAttr(author)}" title="Save for later" aria-label="Save for later" aria-pressed="false">${BOOKMARK_SVG}</button>`;

// The conversation a message button belongs to: {kind, ref, server, agentType, title}, or null where there is nothing to save to. ref is the id or name the server
// that has the conversation knows it by (a board's bare name, not the hub's server/name key); server is that server ("local" for this one).
function conversationOf(btn) {
    if (btn.classList.contains('mb-save-btn')) {
        const { server, name } = splitKey(btn.dataset.convRef || '');
        if (!name) return null;
        return { kind: 'board', ref: name, server: normServer(server), agentType: '', title: btn.dataset.convTitle || name, team: name, author: btn.dataset.author || '' };
    }
    const s = state.currentSession;
    if (!s) return null;
    if (s.type === 'history') return s.name ? { kind: 'agent', ref: s.name, server: LOCAL_SERVER, agentType: s.agent_type || '', title: s.display_name || s.name, team: '', author: '' } : null;
    if (s.type !== 'live' || !s.session_id) return null;
    return { kind: 'agent', ref: s.session_id, server: normServer(sessionServer(s)), agentType: s.agent_type || '', title: s.display_name || s.name || s.session_id, team: s.board_project ? splitKey(s.board_project).name : '', author: '' };
}

/** A bookmark a server sent is used only if its id is a positive safe integer (it goes into a URL: /api/saved/<id>) and its key has the shape its kind has. A registered server
 *  is another machine: a hostile id such as "../../../servers/x" must never become part of a request (Security, #4551). Anything else is dropped. */
export function validSavedItem(i) {
    if (!i || !Number.isSafeInteger(i.id) || i.id <= 0) return false;
    if (typeof i.ref !== 'string' || !i.ref || i.ref.length > 200) return false;
    if (i.kind === 'agent') return typeof i.key === 'string' && /^[0-9a-f]{20}$/.test(i.key);
    if (i.kind === 'board') return typeof i.key === 'string' && /^[1-9][0-9]{0,15}$/.test(i.key);
    return false;
}

// `${kind}:${ref}` -> { items: Map(key -> bookmark), loaded: Promise }, kept while the conversation is on screen and refreshed when the list changes.
const sets = new Map();
const setKey = c => `${c.server}|${c.kind}:${c.ref}`;

function setFor(c) {
    const k = setKey(c);
    let e = sets.get(k);
    if (!e) {
        e = { items: new Map(), loaded: null };
        sets.set(k, e);
    }
    if (!e.loaded) {
        e.loaded = serverFetch(c.server, `/api/saved?kind=${encodeURIComponent(c.kind)}&conv=${encodeURIComponent(c.ref)}`).then(r => (r.ok ? r.json() : { items: [] }))
            .then(d => { e.items = new Map((d.items || []).filter(validSavedItem).map(i => [i.key, i])); return e; })
            .catch(() => { e.loaded = null; return e; });
    }
    return e.loaded; // resolves to the entry once the conversation's bookmarks are read
}

/** A message's words for a button name: collapsed, cut at a word boundary near 40 characters. */
export function snippet(text, max = 40) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1);
    const at = cut.lastIndexOf(' ');
    return (at > max / 2 ? cut.slice(0, at) : cut.slice(0, max)).trim() + '…';
}

/** Who said it and the start of it, for naming a row's buttons ("Save for later: message from Developer: Build is green"), kept on the button as a property so a repaint keeps it.
 *  The words are the message's own (untrusted): they only ever go in as a value, never as markup. */
export function aboutRow(btn) {
    if (!btn) return '';
    const board = btn.classList.contains('mb-save-btn');
    const row = board ? btn.closest('.mb-message') : btn.closest('[data-msg-key]');
    if (!row) return '';
    const who = board ? row.querySelector('.mb-agent-name')?.textContent.trim() || 'Unknown' : row.querySelector('.role-label')?.textContent.trim() || '';
    const words = snippet(row.querySelector(board ? '.mb-message-body' : '.message-text')?.textContent);
    btn.dataset.about = [who, words].filter(Boolean).join(': ');
    return btn.dataset.about;
}

/** The button's name for its state, with the message it is on (a list of these must not read as the same button). */
export function nameSaveButton(btn) {
    const label = btn.getAttribute('aria-pressed') === 'true' ? 'Remove from saved' : 'Save for later';
    const about = aboutRow(btn);
    btn.setAttribute('aria-label', about ? `${label}: message from ${about}` : label);
    return label;
}

function paint(btn, saved) {
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    const label = nameSaveButton(btn);
    btn.classList.toggle('saved', saved);
}

function keyOf(btn) {
    if (btn.classList.contains('mb-save-btn')) return btn.closest('[data-message-id]')?.dataset.messageId || '';
    return btn.closest('[data-msg-key]')?.dataset.msgKey || '';
}

/** Show each save button's state (filled when saved). A button with no conversation to save to is hidden. */
async function syncSavedButtons(root) {
    if (!root || isCloud()) return;
    const btns = [...root.querySelectorAll('.chat-save-btn, .mb-save-btn')];
    if (!btns.length) return;
    const c = conversationOf(btns[0]);
    for (const b of btns) b.hidden = !conversationOf(b);
    if (!c) return;
    const e = await setFor(c);
    for (const b of btns) { const k = keyOf(b); if (k) paint(b, e.items.has(k)); }
}

/** The Saved list changed (done, removed, saved elsewhere): forget what is known and repaint the buttons on screen. */
export function savedChanged() {
    sets.clear();
    for (const root of watched()) syncSavedButtons(root);
}

const WATCHED = ['live-history-messages', 'history-messages', 'mb-messages'];
const watched = () => WATCHED.map(id => document.getElementById(id)).filter(Boolean);

let pending = new Set();
function schedule(root) {
    if (!pending.size) requestAnimationFrame(() => { const roots = [...pending]; pending = new Set(); roots.forEach(syncSavedButtons); });
    pending.add(root);
}

// Messages come in by many routes (a page, a poll, older pages above): a rendered message gets its state when it appears.
function watch() {
    for (const root of watched()) {
        if (root._savedWatch) continue;
        root._savedWatch = new MutationObserver(() => schedule(root));
        root._savedWatch.observe(root, { childList: true, subtree: true });
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();

// The sidebar showing the Saved tab (#4742): open (a phone: the overlay) with the Saved tab the active one. Escape in the sidebar, or the X in its header, closes it.
/** Is the dashboard's own Inbox (the nav tab, with Saved for later in it) on screen? Where the hub serves the dashboard the Inbox is the hub's frame, with no Saved. */
export const savedViewShowing = () => !isCloud() && !!document.getElementById('nav-tab-hub-inbox')?.classList.contains('active');
/** Is Saved on screen, as the right sidebar's tab or as the full-screen page? */
export function savedShowing() {
    if (savedViewShowing()) return true;
    if (currentScope().kind === 'all') return false; // the sidebar has no Saved tab for everything, hidden or not (#4811)
    const dock = document.getElementById('agentic-state');
    if (!dock) return false;
    const open = isPhoneLayout() ? dock.classList.contains('mobile-panel-overlay') : !dock.classList.contains('collapsed');
    return open && !!document.getElementById('agentic-tab-saved')?.classList.contains('active');
}
// Escape closes it, when the key is meant for the sidebar: not from a field, a dialog or a menu that has it.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !savedShowing()) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .modal')) return;
    if (!(t === document.body || t.closest('#agentic-state, #inbox-view, #group-table-view, .top-nav-tab'))) return; // the top tab that opened the Inbox keeps the focus until the list is up
    if (document.querySelector('.goal-detail-pane:not([hidden])')) return; // a goal's task or file pane beside its list: Escape closes that first (detail_pane.js), with the focus on its row (#8914)
    if (document.querySelector('#agentic-saved-detail-pane:not([hidden])')) return; // a message's sheet over the dock is one level back (detail_pane.js closes it); the next Escape leaves
    e.preventDefault();
    const back = savedViewShowing() ? document.querySelector('#inbox-page:not([hidden]) > .back-link') : null; // on a message's (or a task's) page inside the Inbox Escape is one level back, to its table with the focus on its row; the next Escape leaves
    if (back) { back.click(); return; }
    importOnce('./saved.js').then(m => m.closeSaved()).catch(() => {});
});

// The Inbox's Saved folder shows how many are open; refreshed at start and whenever the list changes.
let countTimer = 0;
export function setSavedCount(n) { setInboxCount('saved', n); }
/** The number on the dock's Saved tab: the open items of the page's own scope (an agent or a team), where the Inbox's Saved folder counts everything. */
export function setScopedCount(n) {
    const tc = document.getElementById('saved-tab-count');
    if (tc) tc.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
}
/** The scope of the page on screen: the agent or the team its Saved list and count are of, or everything (saved_scope.js). */
let wantAll = false;
/** The Inbox's Saved folder is being opened: its Saved list is everything's even before the nav tab's switch has finished. */
export function wantAllScope(on) { wantAll = !!on; }
export function currentScope() {
    if (wantAll || savedViewShowing()) return ALL; // the Inbox page is the all scope whatever agent or team is behind it (#4905)
    const key = k => (k ? splitKey(k) : null);
    const s = state.currentSession;
    const dock = dockKind();
    const session = s && (s.type === 'live' || s.type === 'history')
        ? { type: s.type, name: s.name, display_name: s.display_name, session_id: s.session_id, server: s.type === 'live' ? normServer(sessionServer(s)) : LOCAL_SERVER, board: s.board_project ? splitKey(s.board_project) : null, job_title: s.board_job_title || '' }
        : null;
    return scopeOf({ dock, session }) || ALL;
}
let countScopeKey = ''; // the scope the count on screen is of
const openOf = (servers, scope) => Promise.all(servers.map(id => serverFetch(id, '/api/saved' + withScope('?limit=0', scope)).then(r => (r.ok ? r.json() : null)).then(d => (d && d.open) || 0).catch(() => 0))).then(c => c.reduce((a, b) => a + b, 0));
/** The scope's kind on the body: the right sidebar has a Saved tab only for an agent's or a team's page (the CSS follows it), the Inbox's Saved list is everything's. */
function syncScopeAttr() { const k = currentScope().kind; if (document.body.getAttribute('data-saved-scope') !== k) document.body.setAttribute('data-saved-scope', k); }
function refreshSavedCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
        if (isCloud()) return;
        // The top bar's number is everything, on every page (#4905): this server's open items and every online registered server's, in hub mode (a server that does not answer counts none).
        const everywhere = [LOCAL_SERVER, ...(state.hub ? (state.servers || []).filter(s => s && s.id && s.id !== LOCAL_SERVER && s.status === 'online').map(s => s.id) : [])];
        // The dock's Saved tab counts the page's own scope (an agent or a team), on the server it belongs to (#4792).
        const scope = currentScope();
        countScopeKey = scope.key;
        const [all, own] = await Promise.all([openOf(everywhere, ALL), scope.kind === 'all' ? Promise.resolve(0) : openOf([scope.server], scope)]);
        setSavedCount(all);
        setScopedCount(scope.kind === 'all' ? all : own); // (everything's scope has no Saved tab in the dock; its count is the same number)
    }, 50);
}
document.addEventListener('coral:saved-changed', refreshSavedCount);
document.addEventListener('coral:route-changed', () => { syncScopeAttr(); if (currentScope().key !== countScopeKey) refreshSavedCount(); }); // another agent or team on screen: its own count
onDockPage(syncScopeAttr); // another kind of page: the sidebar's Saved tab and the sidebar itself follow the scope
syncScopeAttr();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshSavedCount); else refreshSavedCount();

function postBody(c, key, btn) {
    const text = btn.closest('.mb-message')?.querySelector('.mb-message-body')?.innerText || btn.closest('.chat-bubble')?.querySelector('.message-text')?.innerText || '';
    return { kind: c.kind, ref: c.ref, key, agent_type: c.agentType, title: c.title, snippet: text.slice(0, 1000), said_at: btn.dataset.said || btn.closest('[data-said]')?.dataset.said || '', team: c.team || '', author: c.author || '' };
}

async function save(c, key, body) {
    const r = await serverFetch(c.server, '/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    if (!validSavedItem(out)) throw new Error('the server sent a bookmark this dashboard cannot use');
    (await setFor(c)).items.set(key, out);
    return out;
}

document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.chat-save-btn, .mb-save-btn');
    if (!btn) return;
    e.preventDefault();
    const c = conversationOf(btn);
    const key = keyOf(btn);
    if (!c || !key) return;
    const entry = await setFor(c);
    const have = entry.items.get(key);
    const body = have ? { kind: have.kind, ref: have.ref, key: have.key, agent_type: have.agent_type, title: have.title, snippet: have.snippet, said_at: have.said_at, team: have.team || '', author: have.author || '' } : postBody(c, key, btn);
    btn.disabled = true;
    try {
        if (have) {
            const r = await serverFetch(c.server, `/api/saved/${have.id}`, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
            entry.items.delete(key);
            paint(btn, false);
            showToast('Removed from saved.', false, 6000, { action: { label: 'Undo', onClick: async () => {
                try { await save(c, key, body); syncSavedButtons(btn.closest('#live-history-messages, #history-messages, #mb-messages')); document.dispatchEvent(new CustomEvent('coral:saved-changed')); } catch (err) { showToast(`Could not save the message again: ${err.message}`, true); }
            } } });
        } else {
            await save(c, key, body);
            paint(btn, true);
            showToast('Saved.', false, 5000, { action: { label: 'View saved', onClick: () => importOnce('./saved.js').then(m => m.openSaved()).catch(() => {}) } });
        }
        document.dispatchEvent(new CustomEvent('coral:saved-changed'));
    } catch (err) {
        showToast(`${have ? 'Could not take the message off the list' : 'Could not save the message'}: ${err.message}`, true);
    } finally {
        btn.disabled = false;
        btn.focus({ preventScroll: true });
    }
});

// Keep the top bar's buttons whole at large text sizes: the view selector gets
// its own row, as it does on a very narrow viewport, so neither control is cut.
function fitSavedBar() {
    const big = isPhoneLayout() && parseFloat(getComputedStyle(document.documentElement).fontSize) >= 24;
    document.body.classList.toggle('saved-bar-wrap', big);
}
if (typeof ResizeObserver === 'function') {
    const start = () => { fitSavedBar(); const bar = document.querySelector('.top-bar'); if (bar) new ResizeObserver(fitSavedBar).observe(bar); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}
window.addEventListener('resize', fitSavedBar);
