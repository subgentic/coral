/* The dashboard's own Inbox on the shared sidebar (#7472), loaded the first time the Inbox tab is shown (inbox_tab.js keeps the badge and the counts, which are always there).
 *
 * Three groups, the hub's /inbox order: Needs you (the agents waiting for input, from the live list the dashboard already holds), Tasks (the open tasks assigned to the Operator) and Saved (the
 * messages saved for later). A group's name opens it as a table in the centre (sidebar_groups.js): Needs you is Item, Team, When; Tasks is Task, Priority, State, Team; Saved is Message, Saved, State and
 * one quiet Done or Reopen button per row, with Open and Done as two chips with counts above it. Each row opens its item: an agent (the Agents tab), a task (a page here, which mounts the shared Inbox
 * component, inbox_panel.js, for that one task: its full text and its reply box are the component's own) or a saved message (a page here with Open, Read the whole message and, behind More, Remove).
 * The one search box searches the group on screen: it narrows the rows of Needs you and Tasks, and is the Saved search (the server matches, so it covers every saved message). Saved's Filters and Sort
 * are in Display options. The hub's own framed /inbox is not this: it keeps the frame, full width (inbox_tab.js). */
import { state } from './state.js';
import { sessionServer, keyLabel, identityKey } from './server_base.js';
import { escapeHtml as esc, escapeAttr as escAttr, showView } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { tableMarkup, registerGroupSource, groupHeaderHtml, isGroupFolded, syncPaneGroupToggle, refreshGroupTable, openGroupTable, foldWayBack } from './sidebar_groups.js';
import { isPhoneLayout } from './phone_layout.js';
import { browserLocal } from './safe_storage.js';
import { resolveSessionIdentity, sessionStateInfo } from './session_state.js';
import { whenText } from './when_text.js';
import { pollEvery } from './overload.js';
import { setHidden } from './dom_write.js';
import { onViewShown } from './view_switch.js';
import { importOnce } from './import_once.js';
import { onInboxHooks, setInboxCount, askOf } from './inbox_tab.js';
const { coralInboxAdapter, savedExpandFor } = await importOnce('./inbox_coral.js');
const { mountInbox } = await importOnce('./inbox_panel.js');
const saved = await importOnce('./saved.js');
const { waitingText } = await importOnce('./waiting_text.js'); // a lazy module imports only what loads at startup (import_hygiene): this one loads with it

const $ = id => document.getElementById(id);
const GROUPS = [
    { key: 'needs', label: 'Needs you', search: 'Search needs you', short: 'Search' },
    { key: 'tasks', label: 'Tasks', search: 'Search tasks', short: 'Search' },
    { key: 'saved', label: 'Saved', search: 'Search saved messages', short: 'Search' }, // the box beside Display options and Expand is narrow: its placeholder is the short words, its name the whole ones
];
const GROUP_KEY = 'coral.inbox.tab'; // the group last on screen, kept in this browser
let tasks = [];
let group = (() => { const v = browserLocal.get(GROUP_KEY); return GROUPS.some(g => g.key === v) ? v : 'needs'; })();
const queries = { needs: '', tasks: '', saved: '' }; // each group's own search text (lower case; Saved's goes to the server as typed)
let page = null; // { kind: 'task', project, id } | { kind: 'saved', id }: the item on screen, or null

// ── Needs you ────────────────────────────────────────────────────────────
const waitingSessions = () => (state.liveSessions || []).filter(s => s && s.waiting_for_input);
const teamOf = s => s.board_project ? keyLabel(identityKey(sessionServer(s), s.board_project)) : '';
const needsText = s => [resolveSessionIdentity(s), sessionStateInfo(s).label, askOf(s), teamOf(s)].join(' ').toLowerCase();
const needsRows = () => waitingSessions().filter(s => !queries.needs || needsText(s).includes(queries.needs));

// ── Tasks ────────────────────────────────────────────────────────────────
const STATE_WORDS = { pending: 'Open', in_progress: 'In progress', review_pending: 'In review', blocked: 'Blocked' };
const PRIORITY_WORDS = { high: 'High', medium: 'Medium', low: 'Low' };
const RANK = { high: 0, medium: 1, low: 2 };
const stateOf = t => STATE_WORDS[t.status] || String(t.status || '').replace(/_/g, ' ');
const taskText = t => [t.title, t.board, t.priority, stateOf(t), t.created_by].join(' ').toLowerCase();
const taskRows = () => tasks.filter(t => !queries.tasks || taskText(t).includes(queries.tasks)).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
async function refreshTasks() {
    try {
        tasks = await coralInboxAdapter.listTasks();
        setInboxCount('tasks', tasks.length, tasks.filter(t => t.priority === 'high').length);
    } catch { tasks = []; }
    renderInboxNav(true);
}

// ── Saved ────────────────────────────────────────────────────────────────
const savedCounts = () => saved.savedView().totals;

// ── The sidebar list ─────────────────────────────────────────────────────
const countOf = key => key === 'needs' ? needsRows().length : key === 'tasks' ? taskRows().length : savedCounts().open;
let _navKey = null, _poll = 0;
/** The three groups in the sidebar: Needs you and Tasks list their rows, Saved is its header (its list is long and has its own table). Only drawn when it changed (this runs for every message of the feed). */
export function renderInboxNav(force = false) {
    const list = $('inbox-nav-list');
    if (!list) return;
    const needs = needsRows(), tk = taskRows(), sv = saved.savedView().shown.map(saved.savedItemFacts);
    const openSaved = page && page.kind === 'saved' ? page.id : '';
    const open = page && page.kind === 'task' ? `${page.project}#${page.id}` : '';
    const key = JSON.stringify([group, queries.needs, queries.tasks, open, GROUPS.map(g => isGroupFolded('hub-inbox', g.key)), savedCounts().open,
        needs.map(s => [sessionServer(s), s.session_id, s.display_name, s.waiting_kind, s.waiting_since, teamOf(s), askOf(s)]), tk.map(t => [t.project, t.id, t.title, t.priority, t.status, t.board]), openSaved, sv.map(f => [f.id, f.which, f.saved, f.state])]);
    if (!force && key === _navKey) return;
    _navKey = key;
    if (needs.some(s => s.waiting_since) && !_poll) _poll = pollEvery(() => renderInboxNav(true), 30000); // "waiting 4 min" moves on while the list is open
    const held = list.contains(document.activeElement) ? document.activeElement.dataset.rowKey : null; // the row the keyboard is on
    const needsRow = s => {
        const wt = waitingText(s.waiting_since);
        return `<li class="session-list-item sb-row"><button type="button" class="row-btn" data-on-click="inbox-agent-open" data-row-key="${escAttr('n:' + s.session_id)}" data-name="${escAttr(s.name)}" data-agent-type="${escAttr(s.agent_type)}" data-session-id="${escAttr(s.session_id)}" data-server="${escAttr(sessionServer(s))}"><span class="sb-row-name">${esc(resolveSessionIdentity(s))}</span><span class="sb-row-meta">${esc([sessionStateInfo(s).label, wt].filter(Boolean).join(' · '))}</span></button></li>`;
    };
    const taskRow = t => {
        const here = open === `${t.project}#${t.id}`;
        return `<li class="session-list-item sb-row${escAttr(here ? ' active' : '')}"><button type="button" class="row-btn"${here ? ' aria-current="true"' : ''} data-on-click="inbox-task-open" data-row-key="${escAttr('t:' + t.project + '#' + t.id)}" data-project="${escAttr(t.project)}" data-task-id="${escAttr(t.id)}"><span class="sb-row-name">${esc(t.title || '(no title)')}</span><span class="sb-row-meta">${esc([PRIORITY_WORDS[t.priority] || t.priority, t.board, stateOf(t)].filter(Boolean).join(' · '))}</span></button></li>`;
    };
    const savedRow = f => `<li class="session-list-item sb-row${escAttr(openSaved === f.id ? ' active' : '')}"><button type="button" class="row-btn"${openSaved === f.id ? ' aria-current="true"' : ''} data-on-click="inbox-saved-open" data-row-key="${escAttr('s:' + f.id)}" data-id="${escAttr(f.id)}"><span class="sb-row-name">${esc(f.which)}</span><span class="sb-row-meta">${esc([`Saved ${f.saved}`, f.state].filter(Boolean).join(' · '))}</span></button></li>`;
    list.innerHTML = GROUPS.map(g => groupHeaderHtml('hub-inbox', g.key, g.label, countOf(g.key))
        + (isGroupFolded('hub-inbox', g.key) ? '' : g.key === 'needs' ? needs.map(needsRow).join('') : g.key === 'tasks' ? tk.map(taskRow).join('') : sv.map(savedRow).join(''))).join('');
    if (held) [...list.querySelectorAll('.row-btn')].find(b => b.dataset.rowKey === held)?.focus({ preventScroll: true });
    syncPaneGroupToggle('hub-inbox');
    refreshGroupTable('hub-inbox');
}

// ── The tables ───────────────────────────────────────────────────────────
/** The Saved table's spec: the Inbox's group table, and the dock's Saved tab (`where: 'dock-tab'`: no title row, rows that open the message in the Inbox) are this one list drawn twice. */
function savedTableSpec(where = '') {
        const v = saved.savedView();
        const rows = v.shown.map(saved.savedItemFacts);
        const empty = v.loading ? 'Loading saved items' : v.error ? v.error : v.filtered ? 'No saved messages match this search.' : v.scoped || (v.tab === 'done' ? 'Nothing is marked done.' : 'Nothing is saved for later.'); // the first read says it is loading, not that nothing is saved; a failed one says so
        const multi = rows.some(f => f.serverName); // on a hub the computer each message is on is a column
    return { title: 'Saved', stack: true, headless: where === 'dock-tab', columns: multi ? ['Message', 'Computer', 'Saved', 'State', 'Action'] : ['Message', 'Saved', 'State', 'Action'], chipsLabel: 'Show',
            chips: [{ action: 'inbox-saved-chip', data: { tab: 'open' }, label: 'Open', count: v.totals.open, pressed: v.tab === 'open' }, { action: 'inbox-saved-chip', data: { tab: 'done' }, label: 'Done', count: v.totals.done, pressed: v.tab === 'done' }],
            empty: { line: empty, hint: v.loading || v.error || v.filtered || v.tab === 'done' ? '' : 'Save a message from a chat or a board with its bookmark.' },
            note: [v.query ? 'The search covers every saved message, not only these.' : '', ...v.down.map(d => `${d.label || d.id} did not answer, so its saved messages are not shown.`)].filter(Boolean).join(' '),
            rows: rows.map(f => ({ title: f.which, action: 'inbox-saved-open', data: where ? { id: f.id, where } : { id: f.id },
                cells: [...(multi ? [f.serverName] : []), f.saved, f.state, f.gone ? '' : { action: 'inbox-saved-done', data: { id: f.id }, label: f.done ? 'Reopen' : 'Done', aria: `${f.done ? 'Reopen, move back to Open' : 'Mark done'}: ${f.which}` }] })) };

}

/** A message of the agent's Saved tab, as a sheet over the dock panel (the pane the Artifacts tab uses, detail_pane.js): what the Inbox's page holds (the text, why it cannot be opened, Read the whole message) with Open (the chat) and Remove from saved in its bar. Back, the close button and Escape return to the Saved table, the focus on the row. */
let dockSheetId = '';
async function openDockSavedSheet(id, opener) {
    const it = saved.findSavedItem(id);
    if (!it) return;
    const f = saved.savedItemFacts(it);
    const { openDetailPane, closeDetailPane } = await importOnce('./detail_pane.js');
    let snippetEl = null; // the saved snippet gives way to the whole text once it has come (#7660)
    const x = f.gone ? null : savedExpandFor(it, f.which, { auto: true, onText: has => { if (snippetEl) snippetEl.hidden = has; } });
    const back = () => closeDetailPane({ restoreFocus: true });
    const cannotOpen = f.gone || f.noopen;
    const actions = [];
    if (!cannotOpen) actions.push({ label: f.open.text, primary: true, ariaLabel: f.open.name, run: () => saved.savedOpen(it) });
    actions.push({ label: 'Remove from saved', ariaLabel: `Remove from saved: ${f.which}`, run: async () => { if (await saved.savedRemove(it)) { sayLive('Removed from saved'); back(); } } });
    dockSheetId = id;
    openDetailPane({
        key: `saved:${id}`, title: f.title, sub: [f.said ? `Said ${f.said}` : '', `Saved ${f.saved}`, f.state, f.serverName].filter(Boolean).join(' · '),
        host: $('agentic-saved-detail-pane'), opener, actions,
        body: doc => {
            const link = el('button', 'group-back', '\u2190 Saved'); link.type = 'button'; link.addEventListener('click', back);
            snippetEl = el('p', 'inbox-saved-snippet', f.snippet || '(no text)');
            doc.append(link, snippetEl);
            if (cannotOpen && f.why) doc.append(el('p', 'inbox-saved-why', f.why));
            if (x && !x.root.hidden) doc.append(x.region); // the whole text, read at once; a long one scrolls in the sheet
        },
        onClose: () => {
            dockSheetId = '';
            if (!opener.isConnected) $('saved-table')?.querySelector('.group-chip, .group-table-link')?.focus({ preventScroll: true }); // the row went (removed, or the table was drawn again)
        },
    });
}

/** The dock's Saved tab (#saved-table, saved.js render): the same table for the page's scope, drawn into the dock; the keyboard stays on the control it was on when it is still there. */
export function drawDockSaved(host) {
    const held = host.contains(document.activeElement) ? document.activeElement : null;
    const was = held && { cls: held.className, id: held.dataset.id || held.closest('tr')?.querySelector('.group-table-link')?.dataset.id || '', tab: held.dataset.tab || '' };
    const html = tableMarkup(savedTableSpec('dock-tab'));
    if (host.dataset.drawn !== html) { host.innerHTML = html; host.dataset.drawn = html; }
    if (dockSheetId && !saved.savedView().shown.some(i => saved.savedItemFacts(i).id === dockSheetId)) importOnce('./detail_pane.js').then(m => m.closeDetailPane()); // another agent's Saved is on screen, or the message left the list: its sheet goes
    if (!was) return;
    const same = [...host.querySelectorAll('.group-table-link, .group-table-cell-btn, .group-chip')].find(e => e.className === was.cls && (e.dataset.id || e.closest('tr')?.querySelector('.group-table-link')?.dataset.id || '') === was.id && (e.dataset.tab || '') === was.tab);
    (same || host.querySelector('.group-chip, .group-table-link'))?.focus({ preventScroll: true }); // a row that went (Done, Reopen) leaves the focus on the table's first control, not on the page
}

registerGroupSource('hub-inbox', {
    keys: () => GROUPS.map(g => g.key),
    redraw: () => renderInboxNav(true),
    table: key => {
        if (key === 'needs') {
            // The folder and the agent's own request (#7122) and the goal its task serves (#7302) are columns when any row has one; the goal's cell opens it on its board
            const rows = needsRows(), dirOf = s => String(s.working_directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            const goalOf = s => s.goal && s.goal.id && s.goal.title;
            const opt = [['Folder', rows.some(dirOf), s => dirOf(s) || ''], ['Asks', rows.some(askOf), s => askOf(s)]];
            const goal = rows.some(goalOf);
            return { title: 'Needs you', stack: true, columns: ['Item', 'Team', ...opt.filter(o => o[1]).map(o => o[0]), 'When', ...(goal ? ['Goal'] : [])], empty: { line: 'Nothing needs your input.' },
                rows: rows.map(s => ({ title: resolveSessionIdentity(s), action: 'inbox-agent-open', data: { name: s.name, 'agent-type': s.agent_type, 'session-id': s.session_id, server: sessionServer(s) },
                    cells: [teamOf(s), ...opt.filter(o => o[1]).map(o => o[2](s)), waitingText(s.waiting_since) || '', ...(goal ? [goalOf(s) ? { link: true, action: 'inbox-goal-open', data: { board: s.goal.board || s.board_project || '', 'goal-id': s.goal.id }, label: s.goal.title, aria: `Goal: ${s.goal.title}` } : ''] : [])] })) };
        }
        if (key === 'tasks') {
            return { title: 'Tasks', stack: true, columns: ['Task', 'Priority', 'State', 'Team'], empty: { line: queries.tasks ? 'No task matches the search.' : 'No assigned tasks.' },
                rows: taskRows().map(t => ({ title: t.title || '(no title)', action: 'inbox-task-open', data: { project: t.project, 'task-id': t.id }, cells: [PRIORITY_WORDS[t.priority] || t.priority || '', stateOf(t), t.board || ''] })) };
        }
        if (key === 'saved') return savedTableSpec();
        return null;
    },
    isEmpty: () => false, // the tab opens its group's table itself (showInbox)
    showList: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
    empty: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
});

/** Which group is on screen: the search box is named for it and holds its text, and Display options (Saved's Filters and Sort) is there for Saved only. */
function setGroup(key) {
    if (!GROUPS.some(g => g.key === key)) key = 'needs';
    const was = group;
    group = key;
    browserLocal.set(GROUP_KEY, key);
    const input = $('inbox-search'), g = GROUPS.find(x => x.key === key);
    if (input) {
        const text = key === 'saved' ? (saved.savedView().query || queries.saved) : queries[key];
        if (input.placeholder !== (g.short || g.search)) input.placeholder = g.short || g.search;
        if (input.getAttribute('aria-label') !== g.search) input.setAttribute('aria-label', g.search); // the name stays whole whatever the placeholder says (a placeholder as short as the box's default no longer skips it)
        if (input.value !== text) input.value = text;
    }
    const btn = document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-button]');
    if (btn) setHidden(btn, key !== 'saved');
    const rail = $('sidebar-rail-search');
    if (rail && document.body.getAttribute('data-nav-tab') === 'hub-inbox') { rail.title = g.search; rail.setAttribute('aria-label', g.search); }
    if (was !== key) renderInboxNav(true);
}

// The table on screen names the group (its data-group), a page names its own: the search and Display options follow.
onViewShown(id => {
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return;
    if (id === 'group-table-view') {
        const g = ($('group-table-view')?.dataset.group || '').split(':');
        if (g[0] === 'hub-inbox') setGroup(g[1]);
        if (page) { page = null; $('inbox-page').hidden = true; $('inbox-view')?.removeAttribute('data-phone-item'); renderInboxNav(true); }
    }
});

/** The search box was typed in: it narrows the group on screen (Saved's is the server's search). */
export function filterInbox(value) {
    const text = String(value || '').trim();
    if (group === 'saved') { queries.saved = text; saved.setSavedQuery(text); return; }
    queries[group] = text.toLowerCase();
    renderInboxNav(true);
}

// ── Items: a task's page and a saved message's page ──────────────────────
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
function openPageShell(kindLabel, groupKey) {
    const host = $('inbox-page');
    host.hidden = false;
    host.dataset.saved = '';
    showView('inbox-view'); // a group's table may be on screen: the item is the page now
    $('inbox-local').hidden = false;
    if (isPhoneLayout()) $('inbox-view')?.setAttribute('data-phone-item', '');
    host.replaceChildren();
    const back = el('button', 'group-back', `\u2190 ${kindLabel}`); // the link back to the group's table (the shared one, sidebar_groups.js)
    back.type = 'button'; back.setAttribute('data-on-click', 'inbox-back'); back.dataset.kind = 'hub-inbox'; back.dataset.group = groupKey; // the way back puts the focus on the row it came from
    const phoneBack = el('button', 'group-back inbox-phone-back', '\u2190 Inbox');
    phoneBack.type = 'button'; phoneBack.setAttribute('data-on-click', 'inbox-phone-back');
    host.append(back, phoneBack);
    return host;
}

function openTaskPage(project, id) {
    const t = tasks.find(x => String(x.project) === String(project) && String(x.id) === String(id));
    if (!t) return;
    page = { kind: 'task', project: t.project, id: t.id };
    const host = openPageShell('Tasks', 'tasks');
    host.append(el('h2', 'wf-item-title', t.title || '(no title)'));
    const high = t.priority === 'high';
    host.append(el('p', 'item-meta', [t.created_by ? `From ${t.created_by}` : '', t.board, (PRIORITY_WORDS[t.priority] || t.priority) + (high ? ' priority' : ''), stateOf(t), whenText(t.updated_at || t.created_at)].filter(Boolean).join(' · ')));
    const mount = el('div', 'inbox-task-mount');
    host.append(mount);
    mountInbox(mount, coralInboxAdapter, { region: false, only: { project: t.project, id: t.id }, poll: (fn, ms) => pollEvery(fn, ms) }); // the component's own text and reply box, for this one task
    setGroup('tasks');
    renderInboxNav(true);
    focusTitle(host);
}

let openMore = null;
function closeMore(focus) { const m = openMore; openMore = null; if (!m) return; m.menu.hidden = true; m.toggle.setAttribute('aria-expanded', 'false'); if (focus) m.toggle.focus(); }
document.addEventListener('click', e => { if (openMore && !openMore.wrap.contains(e.target)) closeMore(false); });

function openSavedPage(id) {
    const it = saved.findSavedItem(id);
    if (!it) return;
    const f = saved.savedItemFacts(it);
    page = { kind: 'saved', id };
    const host = openPageShell('Saved', 'saved');
    host.dataset.saved = id;
    host.append(el('h2', 'wf-item-title', f.title));
    host.append(el('p', 'item-meta', [f.said ? `Said ${f.said}` : '', `Saved ${f.saved}`, f.state, f.serverName].filter(Boolean).join(' · ')));
    const snippetEl = el('p', 'inbox-saved-snippet', f.snippet || '(no text)'); // the snippet gives way to the whole text once it has come (#7660)
    host.append(snippetEl);
    if ((f.gone || f.noopen) && f.why) host.append(Object.assign(el('p', 'inbox-saved-why', f.why), {}));
    const bar = el('div', 'item-bar inbox-saved-actions');
    const x = f.gone ? null : savedExpandFor(it, f.which, { auto: true, onText: has => { snippetEl.hidden = has; } }); // the shared component, in its read-at-once mode: the whole text is in the page, no button
    if (x && !x.root.hidden) host.append(x.region);
    const wrap = el('div', 'wf-more'), toggle = el('button', 'btn btn-small', 'More'), menu = el('div', 'wf-more-menu'), rm = el('button', 'btn btn-small btn-warning', 'Remove from saved');
    toggle.type = 'button'; toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', `More for ${f.which}`);
    menu.hidden = true; menu.id = 'inbox-saved-more'; menu.setAttribute('role', 'menu'); toggle.setAttribute('aria-controls', menu.id); rm.setAttribute('role', 'menuitem'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove from saved: ${f.which}`);
    const openMenu = () => { closeMore(false); openMore = { wrap, menu, toggle }; menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); rm.focus(); };
    toggle.addEventListener('click', () => { if (openMore && openMore.wrap === wrap) closeMore(true); else openMenu(); });
    wrap.addEventListener('keydown', e => {
        const isOpen = !!openMore && openMore.wrap === wrap;
        if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); closeMore(true); }
        else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === toggle) { e.preventDefault(); if (!isOpen) openMenu(); }
        else if (isOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && e.target === rm) e.preventDefault(); // one item: the arrows stay on it
    });
    wrap.addEventListener('focusout', e => { if (openMore && openMore.wrap === wrap && !wrap.contains(e.relatedTarget)) closeMore(false); }); // Tab out of the menu closes it
    rm.addEventListener('click', async () => { closeMore(false); if (await saved.savedRemove(it)) { sayLive('Removed from saved'); closePage(true); } });
    menu.append(rm); wrap.append(toggle, menu); bar.append(wrap);
    const open = el('button', 'btn btn-small btn-primary', f.open.text);
    open.type = 'button'; open.setAttribute('aria-label', f.open.name);
    if (f.gone || f.noopen) { open.disabled = true; open.title = f.why; } else open.addEventListener('click', () => saved.savedOpen(it));
    bar.append(open);
    host.append(bar);
    setGroup('saved');
    focusTitle(host);
}

/** A page was opened: the keyboard and a screen reader start at its heading, not on the body. */
function focusTitle(host) { foldWayBack(host, '.inbox-phone-back', '.wf-item-title'); const h = host.querySelector('.wf-item-title'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }

/** Back from a page: the focus goes to the row it came from (in the table, or in the list on a phone), else to the table's title. */
function focusCameFrom(was, inList) {
    if (!was) return;
    const root = inList ? document.querySelector('.sidebar-pane[data-pane="hub-inbox"]') : $('group-table-view');
    const id = CSS.escape(String(was.id));
    const sel = inList ? (was.kind === 'task' ? `.row-btn[data-row-key="${CSS.escape('t:' + was.project + '#' + was.id)}"]` : `.row-btn[data-id="${id}"]`) : (was.kind === 'task' ? `.group-table-link[data-task-id="${id}"]` : `.group-table-link[data-id="${id}"]`);
    const row = root && root.querySelector(sel);
    if (row) row.focus({ preventScroll: true }); else if (!inList) $('group-table-title')?.focus({ preventScroll: true });
}

function sayLive(text) { const live = $('inbox-live'); if (live) { const s = document.createElement('span'); s.textContent = text; live.replaceChildren(s); } }

/** Leave a page for its group's table (a phone: for the list). */
function closePage(openTable = true, focusBack = false) {
    const was = page, g = page ? (page.kind === 'task' ? 'tasks' : 'saved') : group;
    page = null;
    const host = $('inbox-page');
    if (host) { host.hidden = true; host.replaceChildren(); host.dataset.saved = ''; }
    $('inbox-view')?.removeAttribute('data-phone-item');
    renderInboxNav(true);
    if (openTable && !isPhoneLayout()) openGroupTable('hub-inbox', g);
    if (focusBack) focusCameFrom(was, isPhoneLayout() || !openTable);
}

// ── The tab ──────────────────────────────────────────────────────────────
let _mounted = false;
/** Called by switchNavTab('hub-inbox') (where the dashboard builds its own Inbox): the lists are read again and the group last on screen opens as a table (a phone shows the list). */
export async function showInbox() {
    if (!_mounted) {
        _mounted = true;
        onInboxHooks({ needs: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); }, counts: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); } });
        saved.onSavedRender(() => { if (!$('inbox-local')?.hidden) renderInboxNav(true); });
        saved.mountInboxSavedBar($('inbox-saved-bar'));
    }
    $('inbox-local').hidden = false;
    setGroup(group);
    renderInboxNav(true);
    refreshTasks();
    saved.loadSaved(); // everything's list (the Inbox is the all scope), read for the table and the count
    if (page) { if (isPhoneLayout()) $('inbox-view')?.setAttribute('data-phone-item', ''); return; } // a task or a message is open: the tab returns to it
    $('inbox-view')?.removeAttribute('data-phone-item');
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return; // the module arrived after the person had moved on (a notification's click, a chosen agent): its table must not cover that
    if (!isPhoneLayout()) openGroupTable('hub-inbox', group);
}

/** The group the Inbox opens on the next time it is shown, with nothing drawn (the Saved button names it before it switches to the tab, so the last group is not on screen first). */
export function rememberGroup(name) { if (GROUPS.some(g => g.key === name)) { group = name; browserLocal.set(GROUP_KEY, name); } }

/** A group wanted on screen from elsewhere (the Saved button of the top bar): its table opens. */
export async function openInboxGroup(name) {
    if (!GROUPS.some(g => g.key === name)) name = 'needs';
    $('inbox-local') && ($('inbox-local').hidden = false);
    page = null;
    $('inbox-page') && ($('inbox-page').hidden = true);
    setGroup(name);
    openGroupTable('hub-inbox', name);
}

registerActions({
    'inbox-agent-open': el => {
        const name = textOf(el.dataset.name), type = textOf(el.dataset.agentType), sid = textOf(el.dataset.sessionId), server = textOf(el.dataset.server);
        if (!name) return;
        window.switchNavTab?.('agents');
        window.selectLiveSession?.(name, type, sid, server);
    },
    'inbox-task-open': el => { const p = textOf(el.dataset.project), id = textOf(el.dataset.taskId); if (p && id) openTaskPage(p, id); },
    'inbox-saved-open': el => { const id = textOf(el.dataset.id); if (!id) return; if (el.dataset.where === 'dock-tab') openDockSavedSheet(id, el); else openSavedPage(id); }, // the dock's rows open the message as a sheet over the dock (the person stays with the agent)
    'inbox-saved-chip': el => { const t = textOf(el.dataset.tab); if (t) { saved.setSavedTab(t); sayLive(t === 'done' ? 'Showing the messages marked done' : 'Showing the open messages'); } },
    'inbox-saved-done': async el => {
        const it = saved.findSavedItem(textOf(el.dataset.id));
        if (!it) return;
        const done = !it.done_at;
        if (await saved.savedSetDone(it, done)) sayLive(done ? 'Marked done' : 'Moved back to Open');
    },
    'inbox-goal-open': el => { const board = textOf(el.dataset.board), id = Number(el.dataset.goalId); if (board && id) importOnce('./task_goals.js').then(m => m.openGoalOnBoard(board, id)).catch(() => {}); },
    'inbox-phone-back': () => closePage(false, true),
    'inbox-back': () => { const was = page, g = was ? (was.kind === 'task' ? 'tasks' : 'saved') : group; closePage(false); openGroupTable('hub-inbox', g); focusCameFrom(was, false); }, // the link back to the group's table (on a phone too, as the shared back link did), with the focus on the row it came from
});
