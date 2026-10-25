/* The team page (#7453, UI/UX's one team page): the page a team's row opens. Its header (the team's name and ONE status, Add agent and More) and its tab strip (Goals, Messages, Tasks, Agents, Artifacts, Knowledge, Settings) never move; under them
 * is the tab's table or an item's page (a goal's, a task's) with a link back that returns the focus to the row; documents open in the detail pane on the right (detail_pane.js). The address follows: /team/<name>/<tab>[/<n>].
 * This module is the shell: each tab's own panel is built the first time the tab is opened by its own module (goals_view.js, team_tasks_page.js, team_artifacts_page.js); Messages is the board's own column moved in (message_board.js),
 * and Agents, Knowledge and Settings are today's panels of the right dock moved in, until their own builds (stage 3 of #7453). Lazy: loaded by openTeamPage (lazy_panels.js). */
import { state } from './state.js';
import { keyLabel, splitKey, boardFetch, isCloud } from './server_base.js';
import { showView } from './utils.js';
import { note } from './nav.js';
import { keyRoute, TEAM_TABS } from './routes.js';
import { importOnce } from './import_once.js';
import { refreshTeamAvailability } from './team_availability.js';
import { pollEvery } from './overload.js';
import { onDockPage } from './dock_page.js';
const { closeDetailPane } = await importOnce('./detail_pane.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried
const { el } = await importOnce('./team_table.js');
const { quietFocus } = await importOnce('./quiet_focus.js');
import { refreshGoalsTree } from './sidebar_goals.js';

const LABEL = { goals: 'Goals', messages: 'Messages', tasks: 'Tasks', agents: 'Agents', artifacts: 'Artifacts', knowledge: 'Knowledge', settings: 'Settings' };
const S = { team: '', tab: 'goals', item: null, counts: {}, built: false, countSeq: 0 };
const $ = (id) => document.getElementById(id);

export const currentTeamPage = () => (S.team && $('team-page-view') && $('team-page-view').style.display !== 'none' ? { team: S.team, tab: S.tab } : null);

// ── the shell ────────────────────────────────────────────────────────────

function buildOnce() {
    if (S.built) return;
    S.built = true;
    const tabs = $('team-tabs');
    for (const t of TEAM_TABS) {
        const b = el('button', 'team-tab'); b.type = 'button'; b.id = `team-tab-${t}`; b.dataset.tab = t;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false'); b.setAttribute('aria-controls', `team-panel-${t}`); b.tabIndex = -1;
        b.append(el('span', 'team-tab-label', LABEL[t]), el('span', 'team-tab-count'));
        b.addEventListener('click', () => { goTab(t, { focus: false, user: true }); });
        tabs.append(b);
    }
    tabs.addEventListener('keydown', (e) => {
        const list = [...tabs.querySelectorAll('[role=tab]')], i = list.indexOf(document.activeElement);
        if (i < 0) return;
        const to = { ArrowRight: (i + 1) % list.length, ArrowLeft: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        list[to].focus();
        goTab(list[to].dataset.tab, { focus: true, user: true }); // selection follows focus
    });
    $('team-page-add-agent').addEventListener('click', () => { window.showAddAgentToBoard?.(S.team, teamDir()); });
    buildMore();
    // A click or a tap that opens a page or the pane puts the focus on its heading by script: no ring for a pointer, the ring for a key (the dialogs' rule, quiet_focus.js).
    $('team-page-view').addEventListener('click', () => quietFocus($('team-page-view')), true);
}

/** The folder the team works in: where an agent added to it starts. */
function teamDir() {
    const s = (state.liveSessions || []).find(x => x && x.board_project === S.team && x.working_directory);
    return s ? s.working_directory : '';
}

// More: the board's own actions (Select, Export, Pause, Delete), moved here from the board page's header while this page is on screen (they keep their ids and their handlers).
let moreOpen = false;
function buildMore() {
    const host = $('team-page-actions');
    const b = el('button', 'btn team-page-more', 'More'); b.type = 'button'; b.id = 'team-page-more'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'team-page-more-menu');
    const menu = el('div', 'team-more-menu'); menu.id = 'team-page-more-menu'; menu.hidden = true; menu.setAttribute('aria-label', 'More team actions');
    const add = el('button', 'team-more-add', 'Add agent'); add.type = 'button'; add.id = 'team-page-more-add'; // a phone's header has one button: More, with Add agent first
    add.addEventListener('click', () => { window.showAddAgentToBoard?.(S.team, teamDir()); });
    menu.append(add);
    host.append(b, menu);
    const set = (open, { focus = false } = {}) => { moreOpen = open; menu.hidden = !open; b.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button:not([hidden])')?.focus(); else if (focus) b.focus(); };
    b.addEventListener('click', () => set(!moreOpen));
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) set(false); });
    document.addEventListener('keydown', (e) => { if (moreOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(false, { focus: true }); } }, true);
    document.addEventListener('click', (e) => { if (moreOpen && !menu.contains(e.target) && !b.contains(e.target)) set(false); });
}
const BOARD_ACTIONS = ['mb-select-btn', 'mb-export-btn', 'mb-pause-btn', 'mb-delete-btn'];
function adoptBoardActions() {
    const menu = $('team-page-more-menu'); if (!menu) return;
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b && b.parentElement !== menu) { b.dataset.home = b.parentElement ? b.parentElement.id : ''; menu.append(b); } }
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b) b.style.display = ''; } // display-ok: the board page's markup hides these with an inline display:none, which message_board.js clears the same way
    const sel = $('mb-select-btn'); if (sel) sel.hidden = S.tab !== 'messages'; // selecting messages is the Messages tab's
}
function releaseBoardActions() {
    const home = $('mb-more-menu'); if (!home) return;
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b && b.parentElement !== home) { home.append(b); b.hidden = false; } }
}

// ── the header: the team's name and one status ───────────────────────────

function drawHeader() {
    const h = $('team-page-title');
    h.textContent = keyLabel(S.team);
    const server = splitKey(S.team).server;
    if (isCloud() || (server && server !== 'local')) {
        const computer = (state.servers || []).find(s => s.id === server);
        if (computer) h.append(el('span', 'team-page-machine', ` on ${computer.label || computer.id}`));
    }
    document.title = `${keyLabel(S.team)} · Coral`;
}

const ATTENTION = ['queued', 'offline', 'needs_input'];
function drawStatus(data) {
    const s = $('team-page-status'); if (!s) return;
    if (!data || !Array.isArray(data.agents)) { s.textContent = ''; s.className = 'team-page-status'; return; } // kept in the page and empty: a live region that is shown and filled in one turn is not announced
    const n = data.agents.filter(a => ATTENTION.includes(a.availability)).length;
    const text = n ? `${n} ${n === 1 ? 'needs' : 'need'} attention` : 'All well';
    if (s.textContent === text) return; // the same words are not said again
    s.className = `team-page-status ${n ? 'needs' : 'well'}`;
    const dot = el('span', 'team-status-dot'); dot.setAttribute('aria-hidden', 'true');
    s.replaceChildren(dot, document.createTextNode(text));
}

function drawCounts() {
    for (const t of TEAM_TABS) {
        const c = document.querySelector(`#team-tab-${t} .team-tab-count`); if (!c) continue;
        const n = S.counts[t];
        const text = n == null ? '' : String(n);
        if (c.textContent !== text) c.textContent = text;
        c.hidden = !text;
        const label = $(`team-tab-${t}`).querySelector('.team-tab-label');
        // a space between the word and its count, so the tab is read "Goals 2"
        label.textContent = text ? `${LABEL[t]} ` : LABEL[t];
    }
}

/** The counts on the tabs and the header's status: three light reads, repeated while the page is on screen. */
async function readCounts() {
    const team = S.team, seq = ++S.countSeq;
    if (!team) return;
    const [goals, tasks, avail] = await Promise.allSettled([
        boardFetch(team, '/goals?state=proposed,active,blocked,done,dropped&limit=200').then(r => (r.ok ? r.json() : null)),
        boardFetch(team, '/tasks?limit=1').then(r => (r.ok ? r.json() : null)),
        refreshTeamAvailability(team, true),
    ]);
    if (seq !== S.countSeq || team !== S.team) return;
    refreshGoalsTree(team);
    const g = goals.value;
    if (g) S.counts.goals = (Array.isArray(g) ? g : g.goals || []).length;
    const t = tasks.value;
    if (t && Number.isFinite(t.total_open)) S.counts.tasks = t.total_open;
    if (avail.value && Array.isArray(avail.value.agents)) S.counts.agents = avail.value.agents.length;
    drawStatus(avail.value);
    drawCounts();
}
function startCounts() {
    readCounts();
    if (S.timer) return;
    S.timer = pollEvery(() => { const v = $('team-page-view'); if (v && v.style.display !== 'none' && S.team) readCounts(); }, 30000);
}

// ── tabs ─────────────────────────────────────────────────────────────────

const panel = (t) => $(`team-panel-${t}`);

function markTab(tab) {
    for (const t of TEAM_TABS) {
        const b = $(`team-tab-${t}`), on = t === tab;
        b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
        panel(t).hidden = !on;
    }
    $('team-panel-item').hidden = true;
}

/** Choose a tab (the person pressed it, a key moved to it, or an address named it). */
export async function goTab(tab, { focus = false, user = false, item = 0, replace = false } = {}) {
    if (!TEAM_TABS.includes(tab)) tab = 'goals';
    closeDetailPane();
    leaveMessages(tab);
    S.tab = tab; S.item = null;
    markTab(tab);
    adoptBoardActions();
    if (user || item) note(keyRoute('team', S.team, tab, item || null), { replace });
    await fillTab(tab, item);
    if (focus) $(`team-tab-${tab}`).focus();
}

const teamHooks = () => ({
    openTask: (task, goal) => openTaskPage(task, goal ? { kind: 'goal', goal } : { kind: 'tasks' }),
    openGoal: (id) => openGoalPage(id),
    onItem: (id) => { if (S.tab === 'goals' && !S.quiet) note(keyRoute('team', S.team, 'goals', id || null)); },
    onCount: (n) => { },
});

async function fillTab(tab, item = 0) {
    const team = S.team, host = panel(tab);
    try {
        if (tab === 'goals') {
            const m = await importOnce('./goals_view.js');
            m.showGoals(host, team, { page: true, hooks: { ...teamHooks(), onCount: (n) => { S.counts.goals = n; drawCounts(); } } });
            if (item) m.openGoalWhenKnown(item); else if (m.openGoalId()) { S.quiet = true; m.closeGoal(); S.quiet = false; }
        } else if (tab === 'tasks') {
            const m = await importOnce('./team_tasks_page.js');
            await m.showTasks(host, team, { ...teamHooks(), onCount: (n) => { S.counts.tasks = n; drawCounts(); } });
            if (item) openTaskById(item, { kind: 'tasks' });
        } else if (tab === 'artifacts') {
            const m = await importOnce('./team_artifacts_page.js');
            m.showArtifacts(host, team, { onCount: (n, more) => { S.counts.artifacts = more ? `${n}+` : n; drawCounts(); } });
        } else if (tab === 'messages') {
            const m = await importOnce('./message_board.js');
            m.showBoardInPage(team, host);
            adoptBoardActions();
        } else if (tab === 'agents') {
            await moveIn(host, 'agentic-panel-team-view', async () => (await importOnce('./team_availability.js')).showTeamAvailability(team, { workspace: true }));
        } else if (tab === 'settings') {
            await moveIn(host, 'agentic-panel-team-settings', async () => { (await importOnce('./team_working_mode.js')).showTeamWorkingMode(team, { workspace: true }); });
        } else if (tab === 'knowledge') {
            await moveIn(host, 'agentic-panel-knowledge', async () => { const m = await importOnce('./team_artifacts.js'); await m.showKnowledgeInPage(team); });
        }
    } catch (e) { console.error('team page tab', tab, e); host.textContent = ''; host.append(el('p', 'goals-note', 'This tab could not be shown. Reload the page and try again.')); }
}

// A panel of the right dock moved into the page, until its own build.
async function moveIn(host, panelId, render) {
    const p = $(panelId);
    if (p && p.parentElement !== host) { host.replaceChildren(p); p.classList.add('active', 'team-moved-panel'); }
    await render();
}

function leaveMessages(nextTab) {
    if (nextTab === 'messages') return;
    importOnce('./message_board.js').then(m => m.leaveBoardPage?.()).catch(() => {});
}

// ── item pages ───────────────────────────────────────────────────────────

/** A task's page under the Goals or the Tasks tab's header: the same header and tabs, a link back that returns to the row. */
export async function openTaskPage(task, from) {
    const m = await importOnce('./team_tasks_page.js');
    const host = $('team-panel-item');
    const full = (await m.readTask(S.team, task.id)) || task.raw || task;
    const origin = from && from.kind === 'goal' ? panel('goals') : panel(S.tab);
    S.item = { kind: 'task', id: task.id, origin, from };
    const backLabel = from && from.kind === 'goal' ? from.goal.title || 'Goal' : 'Tasks';
    origin.hidden = true;
    host.hidden = false;
    m.renderTaskPage(host, full, {
        project: S.team, backLabel,
        openGoal: (id) => { closeItem(false); openGoalPage(id); },
        onBack: () => closeItem(true),
    });
    note(keyRoute('team', S.team, 'tasks', task.id));
}

async function openTaskById(id, from) {
    const m = await importOnce('./team_tasks_page.js');
    const t = await m.readTask(S.team, id);
    if (t) openTaskPage(t, from);
}

export function closeItem(restoreFocus) {
    if (!S.item) return;
    const { origin, id, from } = S.item;
    S.item = null;
    $('team-panel-item').hidden = true;
    $('team-panel-item').replaceChildren();
    origin.hidden = false;
    if (restoreFocus) {
        if (from && from.kind === 'goal') { note(keyRoute('team', S.team, 'goals', from.goal.id)); origin.querySelector('#goals-detail-title')?.focus(); origin.querySelector(`[data-task-id="${id}"]`)?.focus(); }
        else { note(keyRoute('team', S.team, 'tasks')); importOnce('./team_tasks_page.js').then(m => m.focusTaskRow(id)); }
    }
}

async function openGoalPage(id) {
    if (S.tab !== 'goals') await goTab('goals', { user: true, item: id });
    else { const m = await importOnce('./goals_view.js'); m.openGoalWhenKnown(id); }
}

// ── opening the page ─────────────────────────────────────────────────────

/** Open a team's page. opts: { tab, item, silent (the router is showing it: write no address), replace }. */
export async function openTeamPage(team, opts = {}) {
    if (!team) return false;
    // Another team while this one's settings hold edits: ask first, and stay where we are when the person declines.
    if (S.team && S.team !== team && currentTeamPage()) {
        const { hasUnsavedTeamSettings, confirmTeamWorkspaceChange } = await importOnce('./team_working_mode.js');
        if (hasUnsavedTeamSettings() && !(await confirmTeamWorkspaceChange())) return false;
    }
    const tab = TEAM_TABS.includes(opts.tab) ? opts.tab : 'goals';
    const changed = S.team !== team;
    if (changed) { S.team = team; S.counts = {}; S.item = null; }
    state.selectedTeam = team; // the team on screen (the sidebar marks its row; the panels moved in read it)
    state.boardPageProject = team;
    state.currentBoardServer = splitKey(team).server;
    showView('team-page-view');
    buildOnce();
    if (changed) { // another team: the tables of the last one go, the moved-in panels and the board's column are drawn again for this one
        for (const t of ['goals', 'tasks', 'artifacts']) { const p = panel(t); p.removeAttribute('data-built'); p.replaceChildren(); }
        drawCounts(); drawStatus(null);
    }
    drawHeader();
    if (S.item) closeItem(false);
    if (!opts.silent) note(keyRoute('team', team, tab, opts.item || null), { replace: !!opts.replace });
    startCounts();
    await goTab(tab, { item: opts.item || 0 });
    return true;
}

/** The route changed under the page (Back, Forward, a link): show what it names without writing another address. */
export async function applyTeamRoute(team, tab, item) {
    S.quiet = true;
    try {
        if (S.team === team && currentTeamPage() && !item && S.item) { closeItem(false); }
        if (S.team === team && currentTeamPage() && S.tab === tab && !S.item) {
            if (tab === 'goals') { const m = await importOnce('./goals_view.js'); if (item) m.openGoalWhenKnown(item); else if (m.openGoalId()) m.closeGoal(); return true; }
        }
        return await openTeamPage(team, { tab, item, silent: true });
    } finally { S.quiet = false; }
}

/** Leave the page: the board's column goes back to its own page and the dock's panels back to the dock. */
export function leaveTeamPage() {
    closeDetailPane();
    releaseBoardActions();
    importOnce('./message_board.js').then(m => m.leaveBoardPage?.()).catch(() => {});
    const home = document.getElementById('agentic-block-top');
    for (const id of ['agentic-panel-team-view', 'agentic-panel-team-settings', 'agentic-panel-knowledge']) { const p = $(id); if (p && home && p.parentElement !== home) { home.append(p); p.classList.remove('active', 'team-moved-panel'); } }
    S.team = ''; S.item = null;
}

// Another kind of page on screen (an agent, Chats, Jobs): the team page lets go of what it borrowed.
onDockPage((kind, previous) => { if (previous === 'team' && kind !== 'team') leaveTeamPage(); });
