import { serverColumns, serverMatches, syncServerField } from './inbox_servers.js';
import { needsInputAttention } from './display_activity_hint.js';
/* The dashboard's own Inbox on the shared sidebar (#7472), loaded the first time the Inbox tab is shown (inbox_tab.js keeps the badge and the counts, which are always there).
 *
 * Three groups, the hub's /inbox order: Needs you (the agents waiting for input, from the live list the dashboard already holds), Tasks (the open tasks assigned to the Operator) and Saved (the
 * messages saved for later). A group's name opens it as a table in the centre (sidebar_groups.js): Needs you is Item, Team, When; Tasks is Task, Priority, State, Team; Saved is Message, Saved, State and
 * one quiet Done or Reopen button per row, with Open and Done as two chips with counts above it. Each row opens its item: an agent (the Agents tab), a task (a page here, which mounts the shared Inbox
 * component, inbox_panel.js, for that one task: its full text and its reply box are the component's own) or a saved message (a page here with Open, Read the whole message and, behind More, Remove).
 * The one search box searches the group on screen: it narrows the rows of Needs you and Tasks, and is the Saved search (the server matches, so it covers every saved message). Saved's Filters and Sort
 * are in Display options. The hub's own framed /inbox is not this: it keeps the frame, full width (inbox_tab.js). */
import { state } from './state.js';
import { reviewItems, reviewErrors, refreshReviews, reviewGroups, markReviewed } from './inbox_reviews.js';
import { go, note, backIs, currentRoute } from './nav.js';
import { build, keyRoute, parse as parseRoute, inboxFolderPath } from './routes.js';
import { sessionServer, keyLabel, identityKey, splitKey, goalTeamKey } from './server_base.js';
import { teamLabel } from './server_status.js';
import { showView } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { tableMarkup, registerGroupSource, refreshGroupTable, openGroupTable, foldWayBack } from './sidebar_groups.js';
import { isPhoneLayout } from './phone_layout.js';
import { browserLocal } from './safe_storage.js';
import { resolveSessionIdentity, sessionStateInfo } from './session_state.js';
import { pollEvery } from './overload.js';
import { setHidden } from './dom_write.js';
import { onViewShown } from './view_switch.js';
import { importOnce } from './import_once.js';
import { onInboxHooks, setInboxCount, askOf } from './inbox_tab.js';
const { coralInboxAdapter, savedExpandFor, listInboxGoals } = await importOnce('./inbox_coral.js');
const saved = await importOnce('./saved.js');
const DT = await importOnce('./data_table.js'); // the one table (#7743): the Tasks group's page is its Tasks columns
const TF = await importOnce('./task_filters.js');
const TV = await importOnce('./tasks_view.js'); // the one Tasks view
const VL = await importOnce('./view_list.js'); // the mailbox's view list (#7785)
const TB = await importOnce('./task_bulk.js'); // what the selection bar does to the selected tasks
const Toolbar = await importOnce('./team_toolbar.js'); // the selection bar takes the page's toolbar line (mountSelection)
const GC = await importOnce('./goal_columns.js');
const { mountGoal } = await importOnce('./goal_view.js');
const { mountInboxItem } = await importOnce('./inbox_item_page.js');
const { quietFocus } = await importOnce('./quiet_focus.js');
const GF = await importOnce('./goal_filters.js'); // the Goals folder's search, pills and Filters (#8596)
const IT = await importOnce('./inbox_toolbar.js'); // the folders' toolbar on the shared list bar
const NF = await importOnce('./needs_filters.js'); // the Needs you folder's search, pills and Filters (#8604)
const CF = await importOnce('./chat_filters.js'); // the chat folders' Filters (#8603)
const IA = await importOnce('./inbox_artifacts.js'); // the Artifacts folder (Goal #62): every team's files in one list
const CH = await importOnce('./mailbox_chats.js'); // the chat folders (#7776): All chats, Board history, By CLI, Tags
const { providerName } = await importOnce('./model_labels.js'); // a CLI by its name (Claude, Codex, Antigravity), as the Chats list says it
const { waitingText } = await importOnce('./waiting_text.js'); // a lazy module imports only what loads at startup (import_hygiene): this one loads with it

const $ = id => document.getElementById(id);
const GROUPS = [
    { key: 'needs', label: 'Needs you', search: 'Search needs you', short: 'Search' },
    { key: 'tasks', label: 'Tasks', search: 'Search tasks', short: 'Search' },
    { key: 'goals', label: 'Goals', search: 'Search goals', short: 'Search' }, // the open goals of every team the person runs (GET /api/goals): the team page's goal row plus a Team column (#7776)
    { key: 'artifacts', label: 'Artifacts', search: 'Search artifacts', short: 'Search' }, // every team's artifacts (GET /api/team-artifacts): the team page's list plus a Team filter (Goal #62)
    { key: 'saved', label: 'Saved', search: 'Search saved messages', short: 'Search' }, // the box beside Display options and Expand is narrow: its placeholder is the short words, its name the whole ones
];
const GROUP_KEY = 'coral.inbox.tab'; // the group last on screen, kept in this browser
let tasks = [];
/** A folder's name and its search words: the groups above, or a chat folder (its title comes from the chat folders' own list). */
const groupMeta = key => GROUPS.find(g => g.key === key) || (CH.CHAT_KEY.test(key) && CH.chatFolder(key) ? { key, label: CH.chatFolder(key).title, search: 'Search chats', short: 'Search' } : null);
let group = (() => { const v = browserLocal.get(GROUP_KEY); return groupMeta(v) ? v : 'needs'; })();
const queries = { needs: '', tasks: '', goals: '', artifacts: '', saved: '' }; // a chat folder keeps its search as typed under its own key // each group's own search text (lower case; Saved's goes to the server as typed)
let goalMount = null, goalOpener = null, goalScroll = 0, itemMount = null;
const itemOpeners = new Map();
const folderRoute = { view: 'inbox-goals', sub: 'goals' };
const routeForFolder = key => key === 'goals' ? folderRoute : key === 'tasks' ? { view: 'inbox-tasks', sub: 'tasks' } : key === 'chats-group' ? { view: 'inbox-boards', sub: 'boards' } : null;
const pageGroup = () => page?.kind === 'goal' ? 'goals' : page?.kind === 'tasks' ? 'tasks' : page?.kind === 'boards' ? 'chats-group' : page ? 'saved' : group;
function openItemRoute(kind, team, id, rowKey) {
    const key = kind === 'tasks' ? 'tasks' : 'chats-group', route = routeForFolder(key);
    quietFocus($('inbox-view'));
    itemOpeners.set(key, { key: rowKey, scroll: $('group-table-view')?.scrollTop || 0 });
    note(route);
    go({ ...route, id: team, ...(kind === 'tasks' ? { item: id } : {}) });
}
let page = null; // { kind: 'task', project, id } | { kind: 'saved', id }: the item on screen, or null

// ── Needs you ────────────────────────────────────────────────────────────
const waitingSessions = () => (state.liveSessions || []).filter(needsInputAttention);
const teamOf = s => s.board_project ? teamLabel(identityKey(sessionServer(s), s.board_project)) : ''; // with its computer when a hub has more than one (#8774)
const needsName = s => s.review ? s.review.produced_by || 'Unknown agent' : resolveSessionIdentity(s);
const reviewRows = () => reviewItems().map(a => ({ review: a, session_id: a.reviewKey, display_name: a.name, board_project: splitKey(a.team).name, server: splitKey(a.team).server, waiting_kind: 'review', waiting_summary: 'For review', waiting_since: a.created_at }));
const allNeeds = () => [...waitingSessions(), ...reviewRows()];
const needsText = s => [s.review?.name || '', needsName(s),resolveSessionIdentity(s), sessionStateInfo(s).label, askOf(s), teamOf(s)].join(' ').toLowerCase();
let needsFilters = NF.loadFilters(), needsBar = null;
const needsCtx = { text: needsText, teamOf, nameOf: needsName };
const filteredNeeds = () => NF.ordered(allNeeds().filter(s => NF.matches(s, needsFilters, needsCtx) && serverMatches(s, needsFilters)), needsFilters);
const needsOverflow = () => reviewGroups(filteredNeeds().filter(s => s.review).map(s => s.review)).filter(g => g.more.length);
const needsRows = () => {
    const all = filteredNeeds(), visible = new Set(reviewGroups(all.filter(s => s.review).map(s => s.review)).flatMap(g => g.rows.map(a => a.reviewKey)));
    return all.filter(s => !s.review || visible.has(s.review.reviewKey));
};
/** The Needs you folder's toolbar (#8604): the search, the kind pills (All, Permission, Question, Needs input), the Filters icon (Team, Agent, Waiting longer than, Sort), the chips of what is on. */
function inboxNeedsToolbar() {
    if (!needsBar) {
        needsBar = IT.folderToolbar({
            idp: 'inbox-needs', noun: 'agent', searchLabel: 'Search needs you',
            sorts: { values: NF.SORTS, labels: NF.SORT_LABEL, aria: 'Sort by how long they have waited' },
            fields: [
                { type: 'select', key: 'team', id: 'inbox-needs-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
                { type: 'select', key: 'agent', id: 'inbox-needs-agent', label: 'Agent', values: [], labels: {}, any: 'Any agent' },
                { type: 'select', key: 'longer', id: 'inbox-needs-longer', label: 'Waiting longer than', values: NF.LONGER, labels: NF.LONGER_LABEL, any: 'Any time' },
            ],
            model: { EMPTY: NF.EMPTY, clean: NF.clean, chips: NF.chips, isFiltered: NF.isFiltered, without: NF.without },
        }, next => {
            needsFilters = next; NF.saveFilters(next); queries.needs = next.q.toLowerCase();
            const input = $('inbox-search'); if (input && group === 'needs') input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        });
    }
    const all = allNeeds();
    const teams = [...new Set(all.map(teamOf).filter(Boolean))].sort(), names = [...new Set(all.map(needsName))].sort();
    const rows = all.filter(s => NF.matches(s, { ...needsFilters, kind: '' }, needsCtx));
    const counts = NF.KINDS.filter(k => k !== 'review' || reviewItems().length || needsFilters.kind === 'review').map(k => rows.filter(s => NF.kindOf(s) === k).length);
    const node = needsBar.draw({
        filters: needsFilters,
        options: { team: { values: teams, labels: {} }, agent: { values: names, labels: {} } },
        pills: { label: 'Show agents waiting on', current: needsFilters.kind || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...NF.KINDS.filter(k => k !== 'review' || reviewItems().length || needsFilters.kind === 'review').map((k, i) => ({ key: k, label: NF.KIND_LABEL[k], count: counts[i] }))],
            onPick: key => { needsFilters = { ...needsFilters, kind: key === 'all' ? '' : key }; NF.saveFilters(needsFilters); renderInboxNav(true); } },
    });
    return { node, signature: JSON.stringify([needsFilters, teams, names, counts, rows.length]) };
}

// ── Tasks ────────────────────────────────────────────────────────────────
const RANK = { high: 0, medium: 1, low: 2 };
const stateOf = t => TV.taskWord(t);
const inboxTasksState = DT.tableState();
const needsState = DT.tableState();

async function openReview(row) {
    const { openArtifactViewer } = await importOnce('./artifact_viewer.js');
    openArtifactViewer(row.hex, { server: splitKey(row.team).server, filename: row.name, mediaType: row.media_type, board: splitKey(row.team).name });
}
function reviewActions(row) {
    const box = DT.el('div', 'inbox-review-actions');
    const errorText = DT.el('span', 'inbox-review-error'); errorText.setAttribute('role', 'alert');
    const open = DT.el('button', 'btn btn-small', 'Open'); open.type = 'button';
    open.setAttribute('aria-label', `Open ${row.name}`); open.addEventListener('click', () => openReview(row));
    const done = DT.el('button', 'btn btn-small', 'Mark reviewed'); done.type = 'button';
    done.setAttribute('aria-label', `Mark reviewed: ${row.name}`);
    done.addEventListener('click', async () => {
        done.disabled = true; errorText.textContent = '';
        try {
            await markReviewed(row); sayLive(`Reviewed ${row.name}.`);
            const target = $('group-table-view')?.querySelector('.inbox-review-actions button') || $('group-table-view')?.querySelector('input[type=search]');
            target?.focus({ preventScroll: true });
        } catch (error) { done.disabled = false; errorText.textContent = error.message; }
    });
    box.append(open, done, errorText); return box;
}

const dockSavedState = DT.tableState();
const savedState = DT.tableState(); // one word set for a task's state (Queued, In progress, Blocked, In review, Done), here as everywhere
const goalsState = DT.tableState();
const taskText = t => [t.title, t.board, t.priority, stateOf(t), t.created_by].join(' ').toLowerCase();
let taskFilters = { ...TF.EMPTY }, taskState = 'all', taskBar = null;
const taskMatches = t => serverMatches(t, taskFilters) && (!queries.tasks || taskText(t).includes(queries.tasks.toLowerCase()))
    && (!taskFilters.team || t.project === taskFilters.team)
    && (!taskFilters.priority || t.priority === taskFilters.priority)
    && (!taskFilters.from || Date.parse(t.updated_at || t.created_at) >= new Date(taskFilters.from + 'T00:00:00').getTime());
const taskRows = () => tasks.filter(t => taskMatches(t) && (taskState === 'all' || stateOf(t) === taskState)).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
function inboxTaskToolbar() {
    if (!taskBar) {
        taskBar = TV.tasksToolbar('mine', next => {
            inboxTasksState.selected.clear();
            taskFilters = next;
            queries.tasks = next.q;
            const input = $('inbox-search');
            if (input && group === 'tasks') input.value = next.q;
            renderInboxNav(true);
        });
        taskBar.node.classList.add('inbox-tasks-toolbar', 'inbox-folder-toolbar');
        taskBar.node.querySelector('.list-bar-search-row').classList.add('gt-toolbar');
    }
    const taskTeams = [...new Set(tasks.map(t => t.project))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
    TF.setTeamNames(new Map(taskTeams.map(k => [k, teamLabel(k)])));
    taskBar.setOptions('team', taskTeams, Object.fromEntries(taskTeams.map(k => [k, teamLabel(k)])));
    taskBar.set({ ...taskFilters, q: queries.tasks });
    syncServerField(taskBar);
    if (!inboxTasksState.selected.size) Toolbar.mountSelection(taskBar.node.querySelector('.list-bar-search-row'), null);
    const states = ['Queued', 'In progress', 'In review', 'Blocked'];
    const rows = tasks.filter(taskMatches);
    const active = document.activeElement;
    const held = taskBar.node.contains(active) ? (active.matches('.team-tb-select') ? 'select' : active.dataset.filter) : null;
    IT.adoptPills(taskBar.node, { label: 'Show tasks that are', current: taskState,
            items: [{ key: 'all', label: 'All', count: rows.length }, ...states.map(key => ({ key, label: key, count: rows.filter(t => stateOf(t) === key).length }))],
            onPick: key => { inboxTasksState.selected.clear(); taskState = key; renderInboxNav(true); } });
    if (held) {
        const next = held === 'select' ? taskBar.node.querySelector('.team-tb-select') : [...taskBar.node.querySelectorAll('[data-filter]')].find(el => el.dataset.filter === held);
        next?.focus({ preventScroll: true });
    }
    return { node: taskBar.node, signature: JSON.stringify([taskFilters, queries.tasks, taskState, taskTeams]) };
}
async function refreshTasks() {
    try {
        tasks = await coralInboxAdapter.listTasks();
        setInboxCount('tasks', tasks.length, tasks.filter(t => t.priority === 'high').length);
    } catch { tasks = []; }
    renderInboxNav(true);
}

// ── Goals ────────────────────────────────────────────────────────────────
let goals = []; // the open goals of every team (GET /api/goals): id, board_id, title, outcome, state, rollup, updated_at
const goalKey = g => `${g.board_id}#${g.id}`;
const goalTeam = g => teamLabel(g.board_id); // with its computer when a hub has more than one: two teams called alpha are two (#8774)
let goalFilters = GF.loadFilters(), goalBar = null;
const goalRows = () => GF.ordered(goals.filter(g => GF.matches(g, goalFilters, goalTeam) && serverMatches(g, goalFilters)), goalFilters);
/** The Goals folder's toolbar (#8596): the search, the Filters icon beside it (Team, Driver, Updated since, Sort), the state pills, and the chips of what is on. */
function inboxGoalsToolbar() {
    if (!goalBar) {
        goalBar = IT.folderToolbar({
            idp: 'inbox-goals', noun: 'goal', searchLabel: 'Search goals',
            sorts: { values: GF.SORTS, labels: GF.SORT_LABEL, aria: 'Sort goals' },
            fields: [
                { type: 'select', key: 'team', id: 'inbox-goals-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
                { type: 'select', key: 'driver', id: 'inbox-goals-driver', label: 'Driver', values: [], labels: {}, any: 'Any driver' },
                { type: 'date', key: 'from', id: 'inbox-goals-from', label: 'Updated since' },
            ],
            model: { EMPTY: GF.EMPTY, clean: GF.clean, chips: GF.chips, isFiltered: GF.isFiltered, without: GF.without },
        }, next => {
            goalFilters = next; GF.saveFilters(next);
            const input = $('inbox-search'); if (input && group === 'goals') input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        });
    }
    const teams = [...new Set(goals.map(g => g.board_id))].sort((a, b) => goalTeam({ board_id: a }).localeCompare(goalTeam({ board_id: b })));
    const drivers = [...new Set(goals.map(g => g.driver).filter(Boolean))].sort();
    GF.setTeamNames(new Map(teams.map(t => [t, goalTeam({ board_id: t })])));
    const rows = goals.filter(g => GF.matches(g, { ...goalFilters, state: '' }, goalTeam));
    const counts = GF.STATES.map(key => rows.filter(g => String(g.state || '').toLowerCase() === key).length);
    const node = goalBar.draw({
        filters: goalFilters,
        options: { team: { values: teams, labels: Object.fromEntries(teams.map(t => [t, goalTeam({ board_id: t })])) }, driver: { values: drivers } },
        pills: { label: 'Show goals that are', current: goalFilters.state || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...GF.STATES.map((key, i) => ({ key, label: GF.STATE_LABEL[key], count: counts[i] }))],
            onPick: key => { goalFilters = { ...goalFilters, state: key === 'all' ? '' : key }; GF.saveFilters(goalFilters); renderInboxNav(true); } },
    });
    return { node, signature: JSON.stringify([goalFilters, teams, drivers, counts, rows.length]) };
}
async function refreshGoals() {
    try {
        goals = await listInboxGoals();
    } catch { goals = []; }
    renderInboxNav(true);
}

// ── Chats ────────────────────────────────────────────────────────────────
const chatFilters = new Map(), chatBars = new Map(); // folder key -> its filters, its toolbar
const chatFiltersOf = key => { if (!chatFilters.has(key)) chatFilters.set(key, { ...CF.loadFilters(key), q: queries[key] || '' }); return chatFilters.get(key); };
/** A chat folder's toolbar (#8603): the search and the Filters icon beside it (CLI, Agent, Tag, Dates: the fields the folder does not already decide), the chips below; one bar per folder, kept. */
function inboxChatsToolbar(key) {
    if (!chatBars.has(key)) {
        const has = new Set(CF.fieldsFor(key)), fields = [];
        if (has.has('cli')) fields.push({ type: 'select', key: 'cli', id: 'inbox-chats-cli', label: 'CLI', values: CF.CLIS.map(c => c[0]), labels: Object.fromEntries(CF.CLIS), any: 'Any CLI' });
        if (has.has('agent')) fields.push({ type: 'text', key: 'agent', id: 'inbox-chats-agent', className: 'list-bar-by', label: 'Agent', max: 80, placeholder: 'Agent name' });
        if (has.has('tagId')) fields.push({ type: 'select', key: 'tagId', id: 'inbox-chats-tag', label: 'Tag', values: [], labels: {}, any: 'Any tag' });
        if (has.has('dates')) fields.push({ type: 'date', key: 'from', id: 'inbox-chats-from', label: 'From' }, { type: 'date', key: 'to', id: 'inbox-chats-to', label: 'To' });
        chatBars.set(key, IT.folderToolbar({ idp: 'inbox-chats', noun: 'chat', searchLabel: 'Search chats', fields, model: { EMPTY: CF.EMPTY, clean: CF.clean, chips: CF.chips, isFiltered: CF.isFiltered, without: CF.without } }, next => {
            chatFilters.set(key, next); CF.saveFilters(key, next);
            queries[key] = next.q;
            const input = $('inbox-search'); if (input && group === key) input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        }));
    }
    const tags = CH.chatTags();
    CF.setTagNames(new Map(tags.map(t => [String(t.id), t.name])));
    const filters = chatFiltersOf(key);
    const node = chatBars.get(key).draw({ filters, options: { tagId: { values: tags.map(t => String(t.id)), labels: Object.fromEntries(tags.map(t => [String(t.id), t.name])) } } });
    return { node, signature: JSON.stringify([key, filters, tags.map(t => [t.id, t.name])]) };
}

// ── Saved ────────────────────────────────────────────────────────────────
let savedBar = null;
/** The Saved page's toolbar (#8602): the search, the Open | Done pills and the Filters icon (Type, Team, From, Saved since, Sort) on the same filters as the sidebar's Display options. */
function inboxSavedToolbar() {
    if (!savedBar) {
        savedBar = IT.folderToolbar(saved.savedPageSpec(), next => {
            saved.setSavedFilters(next);
            const input = $('inbox-search'); if (input && group === 'saved') input.value = next.q || ''; // the sidebar's box shows the same words
        });
    }
    const v = saved.savedView(), filters = saved.savedFiltersNow(), options = saved.savedPageOptions();
    const node = savedBar.draw({ filters, options,
        pills: { label: 'Show', current: v.tab, items: [{ key: 'open', label: 'Open', count: v.totals.open }, { key: 'done', label: 'Done', count: v.totals.done }], onPick: key => saved.setSavedTab(key) } });
    return { node, signature: JSON.stringify([filters, v.tab, v.totals, options]) };
}
const savedCounts = () => saved.savedView().totals;

// ── The sidebar list ─────────────────────────────────────────────────────
const countOf = key => key === 'needs' ? allNeeds().length : key === 'tasks' ? taskRows().length : key === 'goals' ? goals.length : key === 'artifacts' ? IA.artifactCount() ?? undefined : key === 'saved' ? savedCounts().open : undefined;
/** The folders of the Inbox (#7785, the mailbox mock): one view list, a name and a count each. Needs you, Tasks and Saved open their table in the centre; */
const folderSections = () => [{ title: 'Needs attention', items: [
    { key: 'needs', label: 'Needs you', count: countOf('needs'), alert: true }, { key: 'tasks', label: 'Tasks', count: countOf('tasks') },
    { key: 'goals', label: 'Goals', count: countOf('goals') },
    { key: 'saved', label: 'Saved', count: countOf('saved') }] },
    { title: 'Files', items: [{ key: 'artifacts', label: 'Artifacts', count: countOf('artifacts') }] }, ...CH.chatSections()];
let _navKey = null, _folders = null, _poll = 0;
/** A folder was picked: a page that is open gives way, and the folder's table opens with the keyboard at its heading. */
function pickFolder(key) {
    if (page) closePage(false);
    setGroup(key);
    noteFolder(key);
    openGroupTable('hub-inbox', key, { focus: true });
    const route = routeForFolder(key); if (route) note(route);
}
/** The address follows the folder (#8652): /inbox/<folder>, so a link, Back and a reload keep it. Goals, Tasks and Board history are other page families' paths (#8571, #8633) where this build has them. A folder that has no path (the route
 *  parser does not know it) leaves the address as it is; the old /chats address is replaced by the folder's, not stacked under it (Back would otherwise come back to it and rewrite it). */
function noteFolder(key) {
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return;
    const path = inboxFolderPath(key), route = path ? parseRoute(path) : null;
    if (!route) return;
    const cur = currentRoute();
    if (cur && cur.view === route.view && cur.sub === route.sub && cur.folder === route.folder) return; // already on this folder's family (an item's page is under the folder's path: its own handler owns the address)
    if (cur && cur.view === 'chats' && (cur.id || cur.query)) return; // a chat's own address, or the Chats list with its search in the address (/chats?q=...): the filters are in it, so it stays
    note(route, { replace: !!cur && cur.view === 'chats' });
}
/** The folders in the sidebar. Only drawn when a count or the current folder changed (this runs for every message of the feed). */
function renderInboxNav(force = false) {
    const list = $('inbox-nav-list');
    if (!list) return;
    const here = pageGroup(), sections = folderSections();
    // what the tables show is part of the key too: the folder list is drawn from the counts, but the table on screen is refreshed (refreshGroupTable below) only when a row of it changed
    const needs = needsRows(), tk = taskRows(), sv = saved.savedView().shown.map(saved.savedItemFacts);
    const key = JSON.stringify([here, sections, queries.needs, queries.tasks, page && `${page.kind}:${page.project || ''}#${page.id}`,
        needs.map(s => [sessionServer(s), s.session_id, s.display_name, s.waiting_kind, s.waiting_since, teamOf(s), askOf(s)]), tk.map(t => [t.project, t.id, t.title, t.priority, t.status, t.board, t.updated_at, t.artifact_count]), sv.map(f => [f.id, f.which, f.saved, f.state])]);
    if (!force && key === _navKey) return;
    _navKey = key;
    if (needsRows().some(s => s.waiting_since) && !_poll) _poll = pollEvery(() => { refreshReviews(); renderInboxNav(true); }, 30000); // "waiting 4 min" in the Needs you table moves on while the tab is open
    if (_folders && list.contains(_folders)) VL.update(_folders, { sections, current: here });
    else { _folders = VL.build({ id: 'inbox-folders', label: 'Inbox views', sections, current: here, onPick: pickFolder }); list.replaceChildren(_folders); }
    const pageList = page && $('inbox-page')?.querySelector('[data-view-list="inbox-goal-folders"], [data-view-list="inbox-item-folders"]'); // an opened item's own folder list (a phone's select) follows the counts too: it was drawn once, with the counts of that moment (#8681)
    if (pageList) VL.update(pageList, { sections, current: here });
    setHidden(document.querySelector('.sidebar-header[data-header="hub-inbox"] [data-group-toggle]'), true); // folders do not fold: the collapse-all button has nothing to fold
    refreshGroupTable('hub-inbox');
}

// ── The tables ───────────────────────────────────────────────────────────
/** Saved uses the same columns in the Inbox and dock; only its opener and table state differ. */
function savedListSpec(where = '') {
    const v = saved.savedView();
    const rows = v.shown.map(saved.savedItemFacts);
    const dock = where === 'dock-tab';
    const multi = rows.some(f => f.serverName);
    const empty = v.loading ? 'Loading saved items' : v.error ? v.error : v.filtered ? 'No saved messages match this search.' : v.scoped || (v.tab === 'done' ? 'Nothing is marked done.' : 'Nothing is saved for later.');
    return { title: 'Saved', noun: ['item', 'items'], headless: dock, chipsLabel: 'Show',
        chips: !dock ? [] : [{ action: 'inbox-saved-chip', data: { tab: 'open' }, label: 'Open', count: v.totals.open, pressed: v.tab === 'open' }, { action: 'inbox-saved-chip', data: { tab: 'done' }, label: 'Done', count: v.totals.done, pressed: v.tab === 'done' }],
        empty: { line: empty, hint: v.loading || v.error || v.filtered || v.tab === 'done' ? '' : 'Save a message from a chat or a board with its bookmark.' },
        note: [v.query ? 'The search covers every saved message, not only these.' : '', ...v.down.map(d => `${d.label || d.id} did not answer, so its saved messages are not shown.`)].filter(Boolean).join(' '), rows,
        signature: JSON.stringify([multi, rows.map(f => [f.id, f.which, f.saved, f.state, f.gone, f.done, f.serverName])]),
        node: () => DT.dataTable({ label: `Saved, ${rows.length}`, rows, rowKey: f => f.id, state: dock ? dockSavedState : savedState, sortBar: !dock, rowName: f => f.which,
            open: (f, row) => dock ? openDockSavedSheet(f.id, row.querySelector('.dt-primary')) : openSavedPage(f.id),
            columns: [
                { key: 'message', label: 'Message', primary: true, width: 'grow', nowrap: false, line: 1, cell: f => { const b = DT.primaryButton(f.which); b.dataset.id = f.id; return b; } },
                ...(dock ? (multi ? [{ key: 'machine', label: 'Computer', line: 2, cell: f => f.serverName || '' }] : []) : serverColumns()),
                { key: 'saved', label: 'Saved', tone: 'tertiary', align: 'end', line: 1, cell: f => f.saved },
                { key: 'state', label: 'State', line: 2, cell: f => (f.state ? DT.tag(f.state) : '') },
                { key: 'action', label: 'Action', hideLabel: true, line: 2, cell: f => {
                    if (f.gone) return '';
                    const b = DT.el('button', 'btn btn-small dt-quiet', f.done ? 'Reopen' : 'Done'); b.type = 'button'; b.setAttribute('aria-label', `${f.done ? 'Reopen, move back to Open' : 'Mark done'}: ${f.which}`);
                    b.addEventListener('click', async () => { const it = saved.findSavedItem(f.id); if (!it) return; const done = !it.done_at; if (await saved.savedSetDone(it, done)) sayLive(done ? 'Marked done' : 'Moved back to Open'); });
                    return b; } },
            ] }).el };
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
            if (!opener.isConnected) $('saved-table')?.querySelector('.group-chip, .dt-primary')?.focus({ preventScroll: true }); // the row went (removed, or the table was drawn again)
        },
    });
}

/** The dock's Saved tab (#saved-table, saved.js render): the same table for the page's scope, drawn into the dock; the keyboard stays on the control it was on when it is still there. */
export function drawDockSaved(host) {
    const held = host.contains(document.activeElement) ? document.activeElement : null;
    const was = held && { cls: held.className, id: held.dataset.id || held.closest('tr')?.dataset.key || '', tab: held.dataset.tab || '' };
    const spec = savedListSpec('dock-tab'), html = tableMarkup(spec), signature = html + spec.signature;
    if (host.dataset.drawn !== signature) {
        const folded = !!host.querySelector('.dt-box.dt-folded');
        host.innerHTML = html;
        const slot = host.querySelector('.group-table-node');
        if (slot) { const table = spec.node(); table.classList.toggle('dt-folded', folded); slot.replaceWith(table); }
        host.dataset.drawn = signature;
    }
    if (dockSheetId && !saved.savedView().shown.some(i => saved.savedItemFacts(i).id === dockSheetId)) importOnce('./detail_pane.js').then(m => m.closeDetailPane()); // another agent's Saved is on screen, or the message left the list: its sheet goes
    if (!was) return;
    const same = [...host.querySelectorAll('.dt-primary, .dt-quiet, .group-chip')].find(e => e.className === was.cls && (e.dataset.id || e.closest('tr')?.dataset.key || '') === was.id && (e.dataset.tab || '') === was.tab);
    (same || host.querySelector('.group-chip, .dt-primary'))?.focus({ preventScroll: true }); // a removed row leaves focus on the first control

}

/** A chat of a folder opens in the chat viewer with its way back ("<- folder"): the folder is kept in state for the viewer and for the browser's Back. */
async function openChat(c) {
    state.inboxFolder = { key: group, label: (groupMeta(group) || {}).label || 'All chats' };
    const isGroup = c.type === 'group' || String(c.session_id || '').startsWith('board:');
    if (isGroup) { const { historyServer } = await importOnce('./history_source.js'); openItemRoute('boards', identityKey(c.server || historyServer(), c.title || String(c.session_id).replace(/^board:/, '')), null, c.session_id); return; }
    const { setHistorySource } = await importOnce('./history_source.js');
    if (!setHistorySource(c.server || 'local')) return;
    window.selectHistorySession?.(c.session_id, null, c);
}

registerGroupSource('hub-inbox', {
    signature: () => JSON.stringify([state.hub, state.servers]),
    toolbar: key => key === 'needs' ? inboxNeedsToolbar() : key === 'tasks' ? inboxTaskToolbar() : key === 'goals' ? inboxGoalsToolbar() : key === 'saved' ? inboxSavedToolbar() : CH.CHAT_KEY.test(key) ? inboxChatsToolbar(key) : key === 'artifacts' ? IA.artifactsToolbar(() => renderInboxNav(true)) : ({ search: { id: 'inbox-search', label: 'Search the Inbox' } }), // the page's toolbar line, the same shape for Needs you, Tasks and Saved (#7723)
    keys: () => GROUPS.map(g => g.key),
    redraw: () => renderInboxNav(true),
    table: key => {
        if (key === 'needs') {
            // the goal its task serves (#7302) is a column when any row has one; the goal's cell opens it on its board
            const rows = needsRows(), dirOf = s => String(s.working_directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            const goalOf = s => s.goal && s.goal.id && s.goal.title;
            const goal = rows.some(goalOf);
            const total = filteredNeeds().length;
            return { title: 'Needs you', noun: ['item', 'items'], rows, count: total > rows.length ? `${rows.length} of ${total}` : total, note: reviewErrors().join(' '), empty: { line: NF.isFiltered(needsFilters) ? 'Nothing that needs you matches the search and filters.' : 'Nothing needs your input.' },
                signature: JSON.stringify([needsOverflow().map(g => [g.name, g.more.map(a => a.reviewKey)]), reviewErrors(), rows.map(s => [sessionServer(s), s.session_id, s.display_name, s.waiting_kind, s.waiting_since, waitingText(s.waiting_since), teamOf(s), askOf(s), goalOf(s) ? s.goal.id : 0, dirOf(s)])]), // the words move on with the clock: they are part of what was drawn
                node: () => { const wrap = DT.el('div', 'inbox-needs-results'); const table = DT.dataTable({ label: `Needs you, ${rows.length}`, rows, rowKey: s => `${sessionServer(s)}:${s.session_id}`, state: needsState, rowName: s => s.review ? `${s.review.name}, for review, ${teamOf(s)}` : resolveSessionIdentity(s),
                    open: s => { if (s.review) { openReview(s.review); return; } window.switchNavTab?.('agents'); window.selectLiveSession?.(s.name, s.agent_type, s.session_id, sessionServer(s)); },
                    columns: [
                        { key: 'agent', label: rows.some(s => s.review) ? 'Item' : 'Agent', primary: true, width: rows.some(s => s.review) ? 'grow' : rows.some(askOf) ? undefined : 'grow', sort: true, sortValue: s => resolveSessionIdentity(s), line: 1, cell: s => { if (s.review) { const name = DT.el('span', 'inbox-review-name', s.review.name); name.title = s.review.name; name.dataset.reviewArtifact = s.review.id; return name; } const w = DT.personButton(resolveSessionIdentity(s), `Open ${resolveSessionIdentity(s)}`); Object.assign(w.querySelector('.dt-primary').dataset, { name: s.name, agentType: s.agent_type, sessionId: s.session_id, server: sessionServer(s) }); return w; } },
                        ...(rows.some(askOf) ? [{ key: 'asks', label: 'Waiting for', width: rows.some(s => s.review) ? 'content' : 'grow', line: 2, cell: s => {
                            if (!s.review) return askOf(s) || '';
                            const metadata = DT.el('span', 'inbox-review-metadata'); metadata.append(DT.el('span', null, 'For review'), DT.el('span', 'inbox-review-team', teamOf(s))); return metadata;
                        } }] : []), // no row has a question: no empty column
                        ...(rows.some(s => s.agent_type) ? [{ key: 'cli', label: 'CLI', sort: true, sortValue: s => providerName(s.agent_type) || '', line: 2, cell: s => (s.agent_type ? DT.tag(providerName(s.agent_type)) : '') }] : []),
                        ...(rows.some(dirOf) ? [{ key: 'folder', label: 'Folder', sort: true, sortValue: s => dirOf(s) || '', line: 0, cell: s => dirOf(s) || '' }] : []), // the folder an agent works in tells two of one name apart (#7122)
                        ...serverColumns(),
                        { key: 'team', label: 'Team', sort: true, sortValue: s => teamOf(s), line: 0, cell: s => teamOf(s) },
                        ...(goal ? [{ key: 'goal', label: 'Goal', line: 0, cell: s => { if (!goalOf(s)) return ''; const l = DT.link(s.goal.title, () => { const team = goalTeamKey(s), id = Number(s.goal.id); if (team && id) go({ view: 'inbox-goals', sub: 'goals', id: team, item: id }); }); l.setAttribute('aria-label', `Goal: ${s.goal.title}`); return l; } }] : []),
                        ...(rows.some(s => s.review) ? [{ key: 'review', label: 'Actions', width: '14rem', line: 1, cell: s => s.review ? reviewActions(s.review) : '' }] : []),
                        { key: 'waiting', label: 'Waiting', tone: 'tertiary', align: 'end', sort: true, sortValue: s => s.waiting_since || '', firstDir: 'desc', line: rows.some(s => s.review) ? 2 : 1, cell: s => waitingText(s.waiting_since) || '' },
                    ] });
                    wrap.append(table.el);
                    for (const g of needsOverflow()) {
                        const p = DT.el('p', 'inbox-review-more', `${g.name}: ${g.more.length} more for review. `);
                        for (const team of new Set(g.more.map(a => a.team))) p.append(DT.link(`Open ${keyLabel(team)} artifacts`, () => go(keyRoute('team', team, 'artifacts'))));
                        wrap.append(p);
                    }
                    return wrap; } };
        }
        if (key === 'tasks') {
            const rows = taskRows();
            return { title: 'Tasks', noun: ['task', 'tasks'], rows, empty: { line: queries.tasks || TF.isFiltered(taskFilters) || taskState !== 'all' ? 'No task matches the filters.' : 'No assigned tasks.' },
                signature: JSON.stringify([rows.map(t => [t.project, t.id, t.title, t.priority, t.status, t.board, t.updated_at, t.artifact_count])]),
                node: () => {
                    const row = document.querySelector('#group-table-view .gt-toolbar');
                    const t = TV.tasksTable('mine', rows, { tweak: columns => columns.flatMap(c => c.key === 'team' ? [...serverColumns(), c] : [c]), ctx: { teamOf: t => teamLabel(t.project) }, rowKey: t => `${t.project}#${t.id}`, // only my tasks: no who; the Team column because the group spans teams
                        open: t => openItemRoute('tasks', t.project, t.id, `${t.project}#${t.id}`), state: inboxTasksState,
                        selectable: { contextKey: 'inbox-tasks', actions: TB.inboxTaskActions(() => { inboxTasksState.selected.clear(); refreshTasks(); }), onChange: keys => row && Toolbar.mountSelection(row, keys.size ? t.bar : null) } }); // the bar takes the toolbar's line while tasks are selected
                    if (row) { Toolbar.mountSelection(row, inboxTasksState.selected.size ? t.bar : null); row.querySelectorAll('.dt-select-toggle').forEach(b => b.remove()); if (isPhoneLayout()) row.append(t.selectButton); }
                    return t.el;
                } };
        }
        if (CH.CHAT_KEY.test(key)) {
            return CH.chatsSpec(key, { query: chatFiltersOf(key).q, params: CF.toParams(key, chatFiltersOf(key)), server: chatFiltersOf(key).server, redraw: () => refreshGroupTable('hub-inbox'), open: openChat,
                after: () => { CH.loadChatCounts(() => renderInboxNav(true)); refreshGroupTable('hub-inbox'); } });
        }
        if (key === 'goals') {
            const rows = goalRows();
            return { title: 'Goals', noun: ['goal', 'goals'], rows, empty: { line: GF.isFiltered(goalFilters) ? 'No goal matches the search and filters.' : 'No open goals.' },
                signature: JSON.stringify(rows.map(g => [g.board_id, g.id, g.title, g.outcome, g.state, g.updated_at, g.rollup])),
                node: () => DT.dataTable({ label: `Goals, ${rows.length}`, rows, rowKey: goalKey, state: goalsState, rowName: g => g.title,
                    open: g => {
                        quietFocus($('inbox-view')); // same pointer-only heading focus rule as the team page
                        goalOpener = { team: g.board_id, id: g.id };
                        goalScroll = $('group-table-view')?.scrollTop || 0;
                        note(folderRoute);
                        go({ ...folderRoute, id: g.board_id, item: g.id });
                    },
                    columns: GC.goalColumns({ teamOf: goalTeam }, ['state', 'goal', 'team', 'progress', 'updated']).flatMap(c => c.key === 'team' ? [...serverColumns(), c] : [c]) }).el };
        }
        if (key === 'artifacts') return IA.artifactsSpec();
        if (key === 'saved') return savedListSpec();
        return null;
    },
    lead: () => { const here = pageGroup(), sections = folderSections(); return { signature: JSON.stringify([here, sections]), node: () => VL.build({ id: 'inbox-folders-page', label: 'Inbox views', sections, current: here, onPick: pickFolder }) }; }, // a phone: the folders are one select on top of the table
    isEmpty: () => false, // the tab opens its group's table itself (showInbox)
    showList: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
    empty: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
});

/** Which group is on screen: the search box is named for it and holds its text, and Display options (Saved's Filters and Sort) is there for Saved only. */
function setGroup(key) {
    if (!groupMeta(key)) key = 'needs';
    const was = group;
    group = key;
    browserLocal.set(GROUP_KEY, key);
    const input = $('inbox-search'), g = groupMeta(key);
    if (input) {
        const text = key === 'saved' ? (saved.savedView().query || queries.saved) : (queries[key] || '');
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
    if (itemMount && id !== 'inbox-view') closePage(false); // release the shared Board before another page takes it
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return;
    if (id === 'group-table-view') {
        const g = ($('group-table-view')?.dataset.group || '').split(':');
        if (g[0] === 'hub-inbox') setGroup(g[1]);
        if (page) { goalMount?.dispose(); goalMount = null; page = null; $('inbox-page').hidden = true; $('inbox-view')?.removeAttribute('data-phone-item'); renderInboxNav(true); }
    }
});

/** The search box was typed in: it narrows the group on screen (Saved's is the server's search). */
export function filterInbox(value) {
    const text = String(value || '').trim();
    if (group === 'saved') { queries.saved = text; saved.setSavedQuery(text); return; }
    if (group === 'artifacts') { IA.setArtifactSearch(text); return; } // the folder's own search box shows the same text
    queries[group] = CH.CHAT_KEY.test(group) || group === 'tasks' ? text : text.toLowerCase();
    if (group === 'tasks') { inboxTasksState.selected.clear(); taskFilters = { ...taskFilters, q: text }; } // a chat search goes to the server as typed
    if (CH.CHAT_KEY.test(group)) chatFilters.set(group, { ...chatFiltersOf(group), q: text }); // the sidebar's box and the page's share the one search (#8603)
    if (group === 'needs') { needsFilters = { ...needsFilters, q: text }; NF.saveFilters(needsFilters); } // the sidebar's box and the page's share the one search (#8604)
    if (group === 'goals') { goalFilters = { ...goalFilters, q: text }; GF.saveFilters(goalFilters); } // the sidebar's box and the page's share the one search (#8596)
    renderInboxNav(true);
}

// ── Saved message page ──────────────────────
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
    const phoneBack = el('button', 'group-back inbox-phone-back', `\u2190 ${kindLabel}`); // a phone: back to the folder's table, which has the folders' select on top
    phoneBack.type = 'button'; phoneBack.setAttribute('data-on-click', 'inbox-phone-back');
    host.append(back, phoneBack);
    return host;
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

/** Back from a page: the focus goes to the row it came from in the table (a phone's list is that table too), else to the table's title. */
function focusCameFrom(was) {
    if (!was) return;
    const root = $('group-table-view');
    const id = CSS.escape(String(was.id));
    const row = root && root.querySelector(`.dt-primary[data-id="${id}"]`);
    if (row) row.focus({ preventScroll: true }); else $('group-table-title')?.focus({ preventScroll: true });
}

function sayLive(text) { const live = $('inbox-live'); if (live) { const s = document.createElement('span'); s.textContent = text; live.replaceChildren(s); } }

/** Leave a page for its group's table (a phone's table has the folders' select on top). */
function closePage(openTable = true, focusBack = false) {
    const was = page, g = pageGroup();
    goalMount?.dispose(); goalMount = null;
    itemMount?.dispose(); itemMount = null;
    page = null;
    const host = $('inbox-page');
    if (host) { host.hidden = true; host.replaceChildren(); host.dataset.saved = ''; host.classList.remove('inbox-goal-page', 'inbox-item-page'); }
    $('inbox-view')?.removeAttribute('data-phone-item');
    renderInboxNav(true);
    if (openTable) openGroupTable('hub-inbox', g);
    if (focusBack) focusCameFrom(was);
}

// ── The tab ──────────────────────────────────────────────────────────────
let _mounted = false;
/** Called by switchNavTab('hub-inbox') (where the dashboard builds its own Inbox): the lists are read again and the group last on screen opens as a table (a phone shows the list). */
export async function showInbox({ folder = '', quiet = false } = {}) {
    if (!_mounted) {
        _mounted = true;
        $('inbox-view').addEventListener('click', () => quietFocus($('inbox-view')), true);
        onInboxHooks({ needs: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); }, counts: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); } });
        saved.onSavedRender(() => { if (!$('inbox-local')?.hidden) renderInboxNav(true); });
        saved.mountInboxSavedBar($('inbox-saved-bar'));
    }
    $('inbox-local').hidden = false;
    if (folder && groupMeta(folder)) { closePage(false); page = null; $('inbox-page') && ($('inbox-page').hidden = true); group = folder; } // a link to a folder: the folder, not the page that was open
    setGroup(group);
    renderInboxNav(true);
    refreshTasks();
    refreshReviews(true);
    refreshGoals();
    CH.loadChatCounts(() => renderInboxNav(true));
    IA.refreshArtifactCount(() => renderInboxNav(true));
    saved.loadSaved(); // everything's list (the Inbox is the all scope), read for the table and the count
    if (quiet || (folder && state.currentSession && state.currentSession.type === 'history')) return; // a chat is on screen, or being opened (a saved message, a link to a chat): the Inbox is drawn under it, for the way back
    if (page) {
        if (isPhoneLayout()) $('inbox-view')?.setAttribute('data-phone-item', '');
        const route = routeForFolder(pageGroup());
        if (route && !currentRoute()?.view.startsWith('inbox-')) note({ ...route, id: page.project, ...(page.id ? { item: page.id } : {}) });
        return;
    } // the tab returns to its open item
    $('inbox-view')?.removeAttribute('data-phone-item');
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return; // the module arrived after the person had moved on (a notification's click, a chosen agent): its table must not cover that
    noteFolder(group);
    openGroupTable('hub-inbox', group); // a phone too: the table has the folders' select on top
}

/** The group the Inbox opens on the next time it is shown, with nothing drawn (the Saved button names it before it switches to the tab, so the last group is not on screen first). */
export function rememberGroup(name) { if (groupMeta(name)) { group = name; browserLocal.set(GROUP_KEY, name); } }

/** A group wanted on screen from elsewhere (the Saved button of the top bar): its table opens. */
export async function openInboxGroup(name) {
    if (!groupMeta(name)) name = 'needs';
    $('inbox-local') && ($('inbox-local').hidden = false);
    closePage(false);
    page = null;
    $('inbox-page') && ($('inbox-page').hidden = true);
    setGroup(name);
    noteFolder(name);
    openGroupTable('hub-inbox', name);
    const route = routeForFolder(name); if (route) note(route);
    if (name === 'goals') restoreGoalList();
    const opener = itemOpeners.get(name), table = $('group-table-view');
    if (opener && table) {
        table.querySelector(`tr[data-key="${CSS.escape(opener.key)}"] .dt-primary`)?.focus({ preventScroll: true });
        table.scrollTop = opener.scroll;
    }
}

function restoreGoalList() {
    const table = $('group-table-view');
    if (!table || !goalOpener) return;
    table.querySelector(`tr[data-key="${CSS.escape(goalOpener.team + '#' + goalOpener.id)}"] .dt-primary`)?.focus({ preventScroll: true });
    table.scrollTop = goalScroll;
}

/** The Inbox owns its goal address and Back; the shared component owns the goal. */
export async function openInboxGoal(team, id) {
    closePage(false);
    await showInbox({ folder: 'goals', quiet: true });
    if (currentRoute()?.view !== 'inbox-goals' || currentRoute()?.id !== team || currentRoute()?.item !== id) return;
    page = { kind: 'goal', project: team, id };
    setGroup('goals');
    const host = $('inbox-page');
    host.hidden = false; host.classList.add('inbox-goal-page'); host.replaceChildren();
    showView('inbox-view');
    $('inbox-view')?.setAttribute('data-phone-item', '');
    host.append(VL.build({ id: 'inbox-goal-folders', label: 'Inbox views', sections: folderSections(), current: 'goals', onPick: pickFolder }));
    const view = el('div', 'goals-page goals-table-page goals-open');
    const body = el('div', 'goals-body'); view.append(body); host.append(view);
    goalMount = mountGoal(body, { team, id, status: sayLive,
        teamLink: build(keyRoute('team', team, 'goals', id)), focusOnOpen: false,
        onTask: task => go({ view: 'inbox-tasks', sub: 'tasks', id: team, item: task.id }), // a task of the goal opens in the Inbox, never on the team page (#8861)
        back: () => { if (backIs(folderRoute) || cameFromInbox()) history.back(); else go(folderRoute); }, // to the Inbox screen it was opened from (a task's Goal line), else the folder
    });
    renderInboxNav(true);
}


/** The screen before this one in the history is an Inbox address (the goal a task was opened from): Back goes there. */
const cameFromInbox = () => /^\/inbox(\/|$)/.test(String(history.state?.prev || ''));

/** Task and Board details share their team renderers, with an Inbox-owned address and way back. */
export async function openInboxItem(kind, team, id) {
    closePage(false);
    const key = kind === 'tasks' ? 'tasks' : 'chats-group', route = routeForFolder(key);
    await showInbox({ folder: key, quiet: true });
    if (currentRoute()?.view !== route.view || currentRoute()?.id !== team || (kind === 'tasks' && currentRoute()?.item !== id)) return;
    page = { kind, project: team, id };
    setGroup(key);
    const host = $('inbox-page'); host.hidden = false; host.classList.add('inbox-item-page'); host.replaceChildren();
    showView('inbox-view'); $('inbox-view')?.setAttribute('data-phone-item', '');
    host.append(VL.build({ id: 'inbox-item-folders', label: 'Inbox views', sections: folderSections(), current: key, onPick: pickFolder }));
    const body = el('div', 'inbox-item-body'); host.append(body);
    itemMount = mountInboxItem(body, { kind, team, id, onChanged: refreshTasks, back: () => { if (backIs(route) || cameFromInbox()) history.back(); else go(route); } }); // Back returns to the Inbox screen it was opened from (a goal, another task), else to the folder
    renderInboxNav(true);
}


registerActions({
    'inbox-saved-chip': el => { const t = textOf(el.dataset.tab); if (t) { saved.setSavedTab(t); sayLive(t === 'done' ? 'Showing the messages marked done' : 'Showing the open messages'); } },
    'inbox-phone-back': () => closePage(true, true),
    'inbox-back': () => { const was = page, g = was ? 'saved' : group; closePage(false); openGroupTable('hub-inbox', g); focusCameFrom(was); }, // the link back to the group's table (on a phone too, as the shared back link did), with the focus on the row it came from
});
