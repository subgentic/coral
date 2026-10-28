import { serverMatches } from './inbox_servers.js';
/* Save for Later (#4510), the list and the jump back: the Saved tab of the right sidebar (Open and Done, newest saved first), which stays open beside the main
 * view while you go back to a saved message. The buttons
 * on the messages and the Inbox's count are in saved_marks.js. An agent still running opens in its Chat view and pages up to the message; one that has ended
 * opens in Chats (History) at the message; a board opens and jumps to the message as the board's search does. A message that is gone (the transcript no longer has
 * it, the board message was deleted) is marked Gone on its item, which keeps its snippet and can only be removed. */
import { isPhoneLayout } from './phone_layout.js';
import { teamLabel } from './server_status.js';
import { whenText } from './when_text.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { sessionServer, normServer, serverFetch, identityKey, LOCAL_SERVER } from './server_base.js';
import { savedChanged, setSavedCount, setScopedCount, wantAllScope, validSavedItem, savedShowing, savedViewShowing, currentScope } from './saved_marks.js';
import { withScope, scopeHeading, scopeEmpty, ALL } from './saved_scope.js';
import { effectiveLiveViewMode, setLiveViewMode, jumpToLiveMessage } from './live_chat.js';
import { buildListBar } from './list_bar.js';
import { importOnce } from './import_once.js';
import { selectInboxTab, rememberInboxGroup } from './inbox_tab.js';
// This module is loaded lazily, so its own parts are loaded the same way (a static import of a module not loaded at startup could not be retried: import_hygiene).
const { KINDS, KIND_LABEL, SORTS, SORT_LABEL, makeModel: savedModel, clean: cleanSaved, isFiltered: savedFiltered, toQuery: savedQuery, keeps: savedKeeps, loadFilters: loadSavedFilters, saveFilters: saveSavedFilters, teamKeyOf, setTeamNames } = await importOnce('./saved_filters.js');

const $ = id => document.getElementById(id);
let tab = 'open';
let items = [];
let down = []; // the registered servers that did not answer the last read: {id, label}
let multi = false; // more than one server answered: each item names its server
const checks = new Map(); // item (uid) -> { state: 'live' | 'ended' | 'board' | 'gone' | 'noopen', why }
// The search and filters (#4778): the server matches (q, kind, conv, order), so a search covers every saved message, not just the ones shown.
let filters = loadSavedFilters();
const setFilters = next => { filters = next; saveSavedFilters(filters); };
let bar = null;
let totals = { open: 0, done: 0 };
let loadSeq = 0; // the read in flight that was asked for last: an answer that comes after a newer ask is dropped, so a slow read of an old filter never overwrites the list of the newer one (#7945)
let scope = ALL; // where the panel was opened from (#4792): the agent or the team on screen, or everything; the server matches it, and the counts are its own
const convTitles = new Map(); // conversation reference -> its title, from every list read: the Conversation filter's options (they must outlast a filter that leaves one)
/** An item's identity across servers: ids are each server's own. */
const uid = it => `${it.server}:${it.id}`;


function when(iso) {
    return iso ? (whenText(iso) || String(iso)) : ''; // the one format of every list (when_text.js, #6961)
}

function ago(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const days = Math.round(h / 24);
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    return when(iso);
}

/** This server's saved messages, and in hub mode every online registered server's (#4551), newest saved first. This server failing is an error; a registered server
 *  that does not answer is a line saying so, and its items are left out. Each item is tagged with the server that has it. */
async function load() {
    const mine = ++loadSeq;
    const here = currentScope();
    if (here.key !== scope.key) { // another agent or team: its own conversations, and a conversation filter of the last one means nothing
        scope = here;
        convTitles.clear();
        if (filters.conv) filters = { ...filters, conv: '' };
    }
    $('saved-ui').setAttribute('aria-label', scopeHeading(scope)); // the panel's name for a screen reader: no visible title, the tab says it (#7926)
    // A scope belongs to one server: only that one is asked (this computer when it is the hub's own).
    const remotes = scope.kind !== 'all' ? (normServer(scope.server) === LOCAL_SERVER ? [] : [{ id: scope.server, label: serverName(scope.server) }])
        : state.hub ? (state.servers || []).filter(s => s && s.id && s.id !== LOCAL_SERVER && s.status === 'online') : [];
    const read = async (server) => {
        const r = await serverFetch(server, '/api/saved' + withScope(savedQuery(filters), scope));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return { server, d };
    };
    const onlyRemote = scope.kind !== 'all' && normServer(scope.server) !== LOCAL_SERVER;
    const [local, ...others] = await Promise.all([onlyRemote ? Promise.resolve(null) : read(LOCAL_SERVER), ...remotes.map(s => read(s.id).catch(() => ({ server: s.id, failed: true, label: s.label || s.id })))]);
    if (mine !== loadSeq) return; // a newer read was asked for while this one was on its way: it draws the list
    const answered = [local, ...others.filter(o => !o.failed)].filter(Boolean);
    down = others.filter(o => o.failed).map(o => ({ id: o.server, label: o.label }));
    multi = scope.kind === 'all' && remotes.length > 0;
    // Only what a server sent in a usable shape is listed (an id goes into a URL: saved_marks.js validSavedItem).
    items = answered.flatMap(a => (Array.isArray(a.d.items) ? a.d.items : []).filter(validSavedItem).map(i => ({ ...i, server: a.server }))).filter(i => savedKeeps(i, filters) && serverMatches(i, filters))
        .sort((a, b) => (filters.sort === 'oldest' ? -1 : 1) * (b.saved_at || '').localeCompare(a.saved_at || ''));
    for (const i of items) if (i.ref && !convTitles.has(i.ref)) convTitles.set(i.ref, i.title || i.ref);
    const open = answered.reduce((n, a) => n + (a.d.open || 0), 0), done = answered.reduce((n, a) => n + (a.d.done || 0), 0);
    totals = { open, done };
    if (scope.kind === 'all') { setSavedCount(open); setScopedCount(open); } else setScopedCount(open); // the Inbox's number is everything's: an agent's or team's list moves only its own tab's
}

/** The name of a server for people: its label, else its id; "This computer" for the hub itself. */
function serverName(id) {
    if (normServer(id) === LOCAL_SERVER) return 'This computer';
    const s = (state.servers || []).find(x => x && x.id === id);
    return (s && s.label) || id;
}

// Is the agent one this server has running now? (a live agent opens in Chat; an ended one in Chats)
function liveAgent(it) {
    return (state.liveSessions || []).find(s => s.session_id === it.ref && normServer(sessionServer(s)) === normServer(it.server)) || null;
}

function srcLabel(it) { return it.title || it.ref; }
/** Which saved message a button is for: its source and the start of its text, so four items do not read as the same three buttons four times (#6541). */
const nameSuffix = new Map(), openSuffix = new Map(); // uid -> " (2 of 3)" for items shown together whose button names would otherwise match (same source and first words; same source for Open), so each reads apart
function cutSnippet(it) { const t = String(it.snippet || '').replace(/\s+/g, ' ').trim(); const c = [...t]; return c.length > 40 ? c.slice(0, 40).join('') + '…' : t; } // cut by characters, not UTF-16 units, so an emoji is never split
function baseName(it) { const t = cutSnippet(it); return t ? `${srcLabel(it)}, ${t}` : srcLabel(it); }
const whichOne = it => baseName(it) + (nameSuffix.get(uid(it)) || '');
/** Work out the suffixes for the items about to be drawn together. */
function nameApart(items) {
    const number = (map, keyOf) => {
        map.clear();
        const seen = new Map(), total = new Map();
        for (const it of items) total.set(keyOf(it), (total.get(keyOf(it)) || 0) + 1);
        for (const it of items) { const k = keyOf(it); if (total.get(k) > 1) { const n = (seen.get(k) || 0) + 1; seen.set(k, n); map.set(uid(it), ` (${n} of ${total.get(k)})`); } }
    };
    number(nameSuffix, baseName);
    number(openSuffix, it => openLabel(it).name);
}

function chipFor(it) {
    const c = checks.get(uid(it));
    if (c && c.state === 'gone') return { text: 'Gone', cls: 'gone' };
    if (it.kind === 'board') return { text: 'Board', cls: '' };
    if (c ? (c.state === 'ended' || c.state === 'noopen') : !liveAgent(it)) return { text: '', cls: 'ended' }; // an ended agent is the usual item: only a live one is marked
    return { text: 'Agent', cls: '' };
}

function openLabel(it) {
    const c = chipFor(it);
    if (it.kind === 'board') return { text: 'Open board', name: `Open board: ${srcLabel(it)}` };
    if (c.cls === 'ended') return { text: 'Open in Chats', name: `Open in Chats: ${srcLabel(it)}` };
    return { text: 'Open chat', name: `Open chat: ${srcLabel(it)}` };
}

const convLabel = ref => convTitles.get(ref) || ref;
const savedSpec = () => ({
    idp: 'sv', noun: 'message', label: 'Search and filter saved messages', searchLabel: 'Search saved messages', placeholder: 'Search saved messages',
    sorts: { values: SORTS, labels: SORT_LABEL, aria: 'Sort saved messages' },
    collapsible: true, // the dock's one top row: Search and the Filters icon, Sort inside its panel (#7926); the Inbox's own bar has noSearch and is unchanged
    fields: [
        { type: 'select', key: 'kind', id: 'sv-kind', label: 'Type', values: KINDS, labels: KIND_LABEL, any: 'Any type' },
        { type: 'select', key: 'conv', id: 'sv-conv', label: 'From', values: [], labels: {}, any: 'Any conversation' },
    ],
    model: savedModel({ convLabel }),
});

/** The bar above the list, told the filters, the conversations there are and how many of the tab's messages match (the tab's own total, which a search does not change). */
function syncBar(shownCount) {
    const host = $('saved-bar');
    if (host) {
        if (!bar) { bar = buildListBar(savedSpec(), next => { setFilters(cleanSaved(next)); refresh(); }); host.append(bar.node); }
        syncOneBar(bar, shownCount);
    }
    if (inboxBar) syncOneBar(inboxBar, shownCount);
}

function syncOneBar(bar, shownCount) {
    const refs = [...convTitles.keys()].sort((a, b) => convLabel(a).localeCompare(convLabel(b)));
    if (filters.conv && !refs.includes(filters.conv)) refs.push(filters.conv);
    bar.setOptions('conv', refs, Object.fromEntries(refs.map(r => [r, convLabel(r)])));
    bar.showField('conv', refs.length > 1 || !!filters.conv);
    const all = tab === 'done' ? totals.done : totals.open;
    const counts = { matched: shownCount, all: Math.max(all, shownCount) };
    // The Inbox's empty state says what to do; a second zero-message label adds nothing. Keep filtered counts.
    if (scope.kind === 'all' && counts.all === 0 && !savedFiltered(filters)) counts.text = '';
    bar.set(filters, counts);
}

function render() {
    const shown = items.filter(i => (tab === 'done') === !!i.done_at);
    syncBar(shown.length);
    verify(shown); // before the items are drawn: their chips and actions read the marks
    nameApart(shown);
    drawDock();
    for (const fn of renderListeners) fn(); // the Inbox's Saved table (inbox_sidebar.js) follows the same list
}

/** The dock's Saved tab is the Inbox's Saved table (inbox_sidebar.js drawDockSaved), for the page's scope: one list, drawn in both places. */
let _dockDrawn = Promise.resolve();
function drawDock() {
    const host = $('saved-table');
    if (host) _dockDrawn = importOnce('./inbox_sidebar.js').then(m => m.drawDockSaved(host)).catch(() => {});
}

// What each shown item points at, read from the list's own answer (#5802): the server marks a bookmark whose message is deleted or whose transcript is not on its computer, so the
// tab asks nothing per item. Only a click (Open) asks the source, in probe().
const GONE_WHY = {
    board: 'This message was deleted from the board, or the board was.',
    gone: 'The transcript no longer has this message, so there is nothing to jump to. The saved text above is all that is left.',
    not_reachable: 'The transcript is gone (the agent was removed), so there is nothing to jump to. The saved text above is all that is left.',
};
function verify(shown) {
    for (const it of shown) {
        if (it.reason === 'gone' || it.reason === 'not_reachable') {
            checks.set(uid(it), { state: 'gone', why: GONE_WHY[it.kind === 'board' ? 'board' : it.reason] });
        } else if (it.kind !== 'board' && !liveAgent(it) && normServer(it.server) !== LOCAL_SERVER) {
            // An ended agent's transcript is in the History of the server that had it, which this hub cannot browse for another server: the item is kept, not opened.
            checks.set(uid(it), { state: 'noopen', why: `This agent has ended. Its history is on ${serverName(it.server)}, and Chats shows only this computer's, so the message cannot be opened from here. The saved text above is kept.` });
        }
    }
}

async function probe(it) {
    if (it.kind === 'board') {
        const r = await serverFetch(it.server, `/api/board/${encodeURIComponent(it.ref)}/messages/all?id=${Number(it.key)}`);
        if (r.status === 404) return { state: 'gone', why: 'This message was deleted from the board, or the board was.' };
        return r.ok ? { state: 'board' } : null;
    }
    const live = liveAgent(it);
    // An ended agent's transcript is in the History of the server that had it, which this hub cannot browse for another server (Chats is this computer's): the item is kept, not opened.
    if (!live && normServer(it.server) !== LOCAL_SERVER) return { state: 'noopen', why: `This agent has ended. Its history is on ${serverName(it.server)}, and Chats shows only this computer's, so the message cannot be opened from here. The saved text above is kept.` };
    const url = live ? `/api/sessions/live/${encodeURIComponent(live.name)}/chat?session_id=${encodeURIComponent(it.ref)}&agent_type=${encodeURIComponent(live.agent_type || it.agent_type || '')}&find_key=${encodeURIComponent(it.key)}`
        : `/api/sessions/history/${encodeURIComponent(it.ref)}?find_key=${encodeURIComponent(it.key)}`;
    const r = await serverFetch(live ? it.server : LOCAL_SERVER, url);
    if (r.status === 404) return { state: 'gone', why: 'The transcript is gone (the agent was removed), so there is nothing to jump to. The saved text above is all that is left.' };
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.found) return { state: 'gone', why: 'The transcript no longer has this message, so there is nothing to jump to. The saved text above is all that is left.' };
    return { state: live ? 'live' : 'ended', index: d.index };
}

let _drawn = false; // the list has been drawn once: a later read keeps what is on screen until the answer comes
let _readError = ''; // why the last read failed, for the Inbox's Saved table (the dock says it in #saved-status)
async function refresh() {
    changedSince = false; // this read starts after every change so far
    if (!_drawn) { // the first read: the bar is already there and the table says it is loading, so nothing moves when the list arrives (#7431)
        syncBar(0);
        drawDock();
    }
    try { await load(); _readError = ''; render(); await _dockDrawn; _drawn = true; } catch (e) { _readError = `Could not read the saved messages (${e.message}).`; drawDock(); $('saved-status').textContent = _readError; for (const fn of renderListeners) fn(); } // the loading line goes: the screen must not say it is loading and that it failed
}

/** On a phone the side panel is an overlay over the chat: it gives way so the jump is seen (the tab is where it was when it is opened again). */
function closeOverlay() { if (isPhoneLayout()) window.toggleAgenticPanel?.(false); }

function status(text) { $('saved-status').textContent = ''; requestAnimationFrame(() => { $('saved-status').textContent = text; }); }

let wired = false;
function wire() {
    if (wired) return;
    wired = true;
    // Another agent or team on screen while the list is open: the list is theirs.
    document.addEventListener('coral:route-changed', () => { if (savedShowing() && currentScope().key !== scope.key) { checks.clear(); refresh(); } });
}

/** The Saved tab was shown (by a click on it or a key): read the list again. */
let showing = null, showAgain = false;
let changedSince = false; // a message was saved or taken off after the read in flight began (coral:saved-changed): that read's answer is already out of date (#7955)
document.addEventListener('coral:saved-changed', () => { changedSince = true; });
export function showSaved() {
    if (showing) { if (changedSince) showAgain = true; return showing; } // the tab's switch and another opener can both ask at once: they share one read, unless the list changed since it began, then one more follows it
    placeUi(); // the right sidebar's Saved tab: the one list is there
    wire();
    checks.clear();
    status('');
    showing = (async () => { try { do { showAgain = false; await refresh(); } while (showAgain); } finally { showing = null; } })();
    return showing;
}

// ── Where the one list is shown (#4811, #7472) ───────────────────────
// The list (#saved-ui) is a single component and lives in the right sidebar's Saved tab (an agent's or a team's page keeps that, scoped). The dashboard's own Inbox no longer moves it: it draws the same
// list as a table of its own on the shared sidebar (inbox_sidebar.js), through the functions above, for the scope "all".
function placeUi() {
    const ui = $('saved-ui'), host = $('agentic-panel-saved');
    if (ui && host && ui.parentElement !== host) host.append(ui);
}
/** Whether the Inbox's Saved group (its table or a saved message's page) is what the centre shows. */
const inboxSavedShowing = () => { const t = $('group-table-view'); return !!t && t.style.display !== 'none' && t.dataset.group === 'hub-inbox:saved' || !!$('inbox-page')?.dataset.saved && !$('inbox-page').hidden; };

let _prevTab = 'agents'; // the nav tab the full-screen page was opened from: Escape returns there
const activeNavTab = () => document.querySelector('.top-nav-tab.active')?.dataset.arg || 'agents';

/** The dashboard's own Inbox was shown (switchNavTab('hub-inbox')): the Saved list is moved into it and read. */
let viewLoad = null, viewAgain = false;
function showSavedView() {
    if (viewLoad) { if (changedSince) viewAgain = true; return viewLoad; } // the nav tab's switch and another opener can both ask at once: one read, and one more after it when the list changed since it began (#7955)
    placeUi();
    wire();
    checks.clear();
    status('');
    viewLoad = (async () => { try { do { viewAgain = false; await refresh(); } while (viewAgain); } finally { viewLoad = null; } })();
    return viewLoad;
}

/** The Inbox at its Saved part, on any page where the scope is all. */
async function openSavedView() {
    if (savedViewShowing()) {
        const onSaved = inboxSavedShowing();
        if (!onSaved) await selectInboxTab('saved'); // the Inbox is open on another group: its Saved table is brought up
        $('group-table-view')?.querySelector('.dt-primary, .group-chip')?.focus();
        return;
    }
    dropJumpBar();
    _prevTab = activeNavTab() === 'hub-inbox' ? _prevTab : activeNavTab();
    wantAllScope(true); // the Inbox is everything's, whatever agent or team is behind it
    await rememberInboxGroup('saved'); // before the tab shows: the Inbox opens on Saved, not on the group it was last left on
    window.switchNavTab?.('hub-inbox');
    try { const read = showSavedView(); await selectInboxTab('saved'); await read; } finally { wantAllScope(false); } // the Inbox at its Saved group: the table is up at once and says it is loading (a phone waited for the read first and showed the list meanwhile)
    $('group-table-view')?.querySelector('.dt-primary, .group-chip')?.focus();
}

let _before = null; // {open, tab}: the dock as it was when Saved opened it
function dockOpen() {
    const dock = $('agentic-state');
    return !!dock && (isPhoneLayout() ? dock.classList.contains('mobile-panel-overlay') : !dock.classList.contains('collapsed'));
}
/** Close the sidebar Saved opened: the tab the agent's dock had is shown again if it was open, the sidebar is shut if it was not. The focus goes to the active top tab (the full-screen page) or the panel toggle (the sidebar). */
export function closeSaved({ focus = true } = {}) {
    if (savedViewShowing()) { // the full-screen page: back to the page it was opened from
        window.switchNavTab?.(_prevTab && _prevTab !== 'hub-inbox' ? _prevTab : 'agents');
        if (focus) document.querySelector('.top-nav-tab.active')?.focus();
        return true;
    }
    if (!savedShowing()) return false;
    const before = _before; _before = null;
    if (before && before.open && before.tab && before.tab !== 'saved') window.switchAgenticTab?.(before.tab, 'top');
    else window.toggleAgenticPanel?.(false);
    if (focus) $('panel-toggle-btn')?.focus();
    return true;
}

/** The right sidebar's Saved tab: the right sidebar of the page on screen open on its Saved tab (or the tab focused if it already is), the focus inside it. Every page has the
 *  sidebar and the tab (#4539), so nothing has to be selected first. */
export async function openSaved() {
    if (currentScope().kind === 'all') return openSavedView(); // never an all-scope list in the right sidebar (#4811)
    dropJumpBar();
    // What the sidebar was before, so closing leaves an agent's own dock as it was: open on its tab, or shut.
    if (!savedShowing()) _before = { open: dockOpen(), tab: document.querySelector('#agentic-block-top .agentic-tab.active')?.dataset.tab || '' }; // opening it again (the toast's link) keeps what the dock was before the first open
    const btn = $('agentic-tab-saved');
    btn?.classList.remove('tab-hidden'); // a tab the user hid is still what this button opens
    window.toggleAgenticPanel?.(true);
    window.switchAgenticTab?.('saved', 'top'); // refreshes through showSaved()
    btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the tab row scrolls sideways on a phone: the tab shown is in view
    tab = 'open';
    wire();
    await showSaved();
    ($('saved-table').querySelector('.group-chip, .dt-primary') || $('saved-bar').querySelector('input, button'))?.focus();
}

// ── The Inbox's Saved group (#7472) ──────────────────────────────────
// The dashboard's own Inbox draws this same list as a table on the shared sidebar (inbox_sidebar.js). It reads it through this small surface and changes it through the same functions the list's
// buttons use, so the Done a table row makes and the Done the right sidebar's list makes are one action, and the two lists never disagree.
const renderListeners = new Set();
let inboxBar = null; // the Filters and Sort bar in the Inbox's Display options: the search is the sidebar's own box, so this one has none (spec.noSearch)
/** fn() is called after every draw of the list. */
export function onSavedRender(fn) { renderListeners.add(fn); }
/** What the Inbox shows: the tab's items (Open or Done), both totals, the servers that did not answer, and whether a search or filter is on. */
export function savedView() {
    return { loading: !_drawn && !_readError, error: _readError, scoped: scope.kind === 'all' ? '' : scopeEmpty(scope, tab), tab, totals: { ...totals }, shown: items.filter(i => (tab === 'done') === !!i.done_at), down: [...down], filtered: savedFiltered(filters), query: filters.q || '' };
}
/** One item's facts for a row or a page: its words, and what it can do. */
export function savedItemFacts(it) {
    const c = chipFor(it), chk = checks.get(uid(it));
    return { id: uid(it), server: it.server, title: srcLabel(it), snippet: it.snippet || '', snip: cutSnippet(it), saved: ago(it.saved_at), said: it.said_at ? when(it.said_at) : '', done: !!it.done_at,
        state: chk && chk.state === 'gone' ? 'Gone' : it.done_at ? 'Done' : 'Open', gone: !!(chk && chk.state === 'gone'), noopen: !!(chk && chk.state === 'noopen'), why: chk ? chk.why || '' : '',
        serverName: multi ? serverName(it.server) : '', which: whichOne(it), open: openLabel(it), chip: c.text, kind: it.kind };
}
export const findSavedItem = id => items.find(i => uid(i) === id) || null;
export function setSavedTab(t) { tab = t === 'done' ? 'done' : 'open'; render(); }
/** The sidebar's search: the server matches, so it covers every saved message, not only the ones shown. */
export function setSavedQuery(q) {
    const next = cleanSaved({ ...filters, q });
    if (JSON.stringify(next) === JSON.stringify(filters)) return Promise.resolve();
    setFilters(next);
    return refresh();
}
/** Read the list now (the Inbox's Saved group was opened), for the scope the Inbox is (everything). */
export function loadSaved() { checks.clear(); wire(); return refresh(); }
/** Done or Reopen, Remove, Open: the same actions as the list's buttons (their focus and announcements are the list's own, which the Inbox does not show). */
export async function savedSetDone(it, done) {
    const r = await serverFetch(it.server, `/api/saved/${it.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    if (!r.ok) { showToast('Could not change the saved message', true); return false; }
    await refresh();
    savedChanged();
    return true;
}
export async function savedRemove(it) {
    const r = await serverFetch(it.server, `/api/saved/${it.id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) { showToast('Could not remove the saved message', true); return false; }
    await refresh();
    savedChanged();
    return true;
}
export function savedOpen(it) { return openSavedLink(it); }
/** The Inbox's Saved page toolbar (#8602) works on the same filters as the sidebar's Display options: what they are now, a change (cleaned, and the list read again), the spec of the page's bar, and the options that follow the data. */
export const savedFiltersNow = () => ({ ...filters });
export function setSavedFilters(next) { setFilters(cleanSaved(next)); return refresh(); }
export const savedPageSpec = () => ({
    ...savedSpec(), idp: 'inbox-saved', placeholder: 'Search saved messages',
    fields: [
        { type: 'select', key: 'kind', id: 'inbox-saved-kind', label: 'Type', values: KINDS, labels: KIND_LABEL, any: 'Any type' },
        { type: 'select', key: 'team', id: 'inbox-saved-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
        { type: 'select', key: 'conv', id: 'inbox-saved-conv', label: 'From', values: [], labels: {}, any: 'Any conversation' },
        { type: 'date', key: 'from', id: 'inbox-saved-from', label: 'Saved since' },
    ],
});
export function savedPageOptions() {
    const refs = [...convTitles.keys()].sort((a, b) => convLabel(a).localeCompare(convLabel(b)));
    if (filters.conv && !refs.includes(filters.conv)) refs.push(filters.conv);
    const teams = [...new Set(items.map(teamKeyOf).filter(Boolean))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
    if (filters.team && !teams.includes(filters.team)) teams.push(filters.team);
    const teamWords = Object.fromEntries(teams.map(k => [k, teamLabel(k)])); // with the computer when a hub has more than one (#8839)
    setTeamNames(new Map(Object.entries(teamWords)));
    return { conv: { values: refs, labels: Object.fromEntries(refs.map(r => [r, convLabel(r)])) }, team: { values: teams, labels: teamWords } };
}
/** The bar for the Inbox's Display options (Filters and Sort; no search), built once into `host`. */
export function mountInboxSavedBar(host) {
    if (inboxBar || !host) return;
    inboxBar = buildListBar({ ...savedSpec(), idp: 'svi', noSearch: true }, next => { setFilters(cleanSaved({ ...next, q: filters.q })); refresh(); });
    host.append(inboxBar.node);
    syncOneBar(inboxBar, savedView().shown.length);
}

// ── The jump ──────────────────────────────────────────────────────────

/** A slim bar above the conversation after a jump: where you are, and a way back to the list. */
let _jumpFrom = 'sidebar'; // where the last jump started: the full-screen page ('view') or the right sidebar's list
function dropJumpBar() { document.getElementById('saved-jumpbar')?.remove(); }
function showJumpBar(container) {
    dropJumpBar();
    if (!container || !container.parentElement) return;
    const bar = document.createElement('div');
    bar.id = 'saved-jumpbar';
    bar.className = 'jumpbar';
    bar.setAttribute('role', 'status');
    const t = document.createElement('span'); t.textContent = 'Jumped to a saved message.';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'btn btn-small'; back.textContent = 'Back to Saved';
    back.addEventListener('click', () => { dropJumpBar(); if (_jumpFrom === 'view') openSavedView(); else openSaved(); }); // back to the list the jump started from
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn btn-small'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    x.addEventListener('click', dropJumpBar);
    bar.append(t, back, x);
    container.parentElement.insertBefore(bar, container);
    setTimeout(() => { if (bar.isConnected) bar.remove(); }, 60000);
}

/** The message the jump landed on carries the "Saved" tag (and the search-target outline the other jumps use). */
function tagTarget(el) {
    for (const old of document.querySelectorAll('.saved-jump')) old.classList.remove('saved-jump');
    el.classList.add('saved-jump');
}

/** The jump a link makes (#4596, saved_link.js): the same as the Saved tab's Open. A message that is gone says so in a toast, and the Saved tab is the place to see what is left of it. */
export async function openSavedLink(it) {
    try {
        const found = await probe(it);
        if (found && found.state === 'gone') { showToast(found.why, true); return false; }
        if (found && found.state === 'noopen') { showToast(found.why, true); return false; }
    } catch (e) {
        showToast(`Could not open the saved message: ${e.message}`, true);
        return false;
    }
    await openItem(it);
    return true;
}

async function openItem(it) {
    _jumpFrom = savedViewShowing() ? 'view' : 'sidebar';
    try {
        const found = await probe(it);
        if (found && found.state === 'gone') { checks.set(uid(it), found); render(); return; }
        const leave = tab => { if (savedViewShowing()) window.switchNavTab?.(tab); }; // from the full-screen page: the tab of where the item is, so the page is left (and the list goes back to the sidebar)
        if (it.kind === 'board') {
            closeOverlay();
            leave('board');
            window.selectBoardProject(identityKey(it.server, it.ref), Number(it.key));
            // the board marks and focuses the message when it is drawn; the tag and the bar follow
            for (let i = 0; i < 100; i++) {
                const t = document.querySelector(`#mb-messages [data-message-id="${CSS.escape(it.key)}"].chat-search-target`);
                if (t) { tagTarget(t); showJumpBar($('mb-messages')); break; }
                await new Promise(r => setTimeout(r, 100));
            }
            return;
        }
        const live = liveAgent(it);
        const index = found ? found.index : 0;
        closeOverlay();
        if (live) {
            leave('agents');
            await window.selectLiveSession(live.name, live.agent_type, live.session_id, normServer(sessionServer(live)));
            if (effectiveLiveViewMode() !== 'chat') setLiveViewMode('chat');
            if (!(await jumpToLiveMessage(it.key, index))) { showToast('That message could not be found any more', true); return; }
            const t = document.querySelector(`#live-history-messages [data-msg-key="${CSS.escape(it.key)}"]`);
            if (t) tagTarget(t);
            showJumpBar($('live-history-messages'));
        } else {
            leave('history');
            await window.selectHistorySession(it.ref, { message_index: index });
            for (let i = 0; i < 100; i++) {
                const t = document.querySelector(`#history-messages [data-msg-key="${CSS.escape(it.key)}"]`);
                if (t && document.querySelector('#history-messages .chat-search-target')) { tagTarget(document.querySelector('#history-messages .chat-search-target')); showJumpBar($('history-messages')); break; }
                await new Promise(r => setTimeout(r, 100));
            }
        }
    } catch (e) {
        showToast(`Could not open the saved message: ${e.message}`, true);
    }
}
