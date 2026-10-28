import { openTask } from './task_navigation.js';
/* The team page (#7453, UI/UX's one team page): the page a team's row opens. Its header (the team's name and ONE status, Add agent and More) and its tab strip (Goals, Messages, Tasks, Agents, Artifacts, Knowledge, Settings) never move; under them
 * is the tab's table or an item's page (a goal's, a task's) with a link back that returns the focus to the row; documents open in the detail pane on the right (detail_pane.js). The address follows: /team/<name>/<tab>[/<n>].
 * This module is the shell: each tab's own panel is built the first time the tab is opened by its own module (goals_view.js, team_tasks_page.js, team_artifacts_page.js); Messages is the board's own column moved in (message_board.js),
 * and Agents, Knowledge and Settings are today's panels of the right dock moved in, until their own builds (stage 3 of #7453). Lazy: loaded by openTeamPage (lazy_panels.js). */
import { state } from './state.js';
import { keyLabel, splitKey, boardFetch, teamFetch, isCloud, teamWorkDir, inTeam } from './server_base.js';
const { wakingSince, stopWaking } = await importOnce('./team_waking.js'); // lazy like this file (the Wake action loads it too)
import { showView } from './utils.js';
import { note, go } from './nav.js';
import { keyRoute, TEAM_TABS } from './routes.js';
import { importOnce } from './import_once.js';
import { refreshTeamAvailability } from './team_availability.js';
import { pollEvery } from './overload.js';
import { onViewShown } from './view_switch.js';
import { setPreviewSession } from './preview_pane.js';
import { renderLiveSessions } from './render.js';
import { watchScrollCue } from './scroll_cue.js';
const { closeDetailPane } = await importOnce('./detail_pane.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried
const { el } = await importOnce('./team_table.js');
const { quietFocus } = await importOnce('./quiet_focus.js');

const PHONE_MORE = ['knowledge', 'messages']; // (the last three of TEAM_TABS: the row is its first four, Goals, Agents, Tasks, Artifacts, in the operator's order, #8791) // the tabs a phone puts behind its More menu (CSS hides their tabs under 761 px)
const LABEL = { goals: 'Goals', messages: 'Board', tasks: 'Tasks', agents: 'Agents', artifacts: 'Artifacts', knowledge: 'Knowledge' };
const S = { team: '', tab: 'goals', item: null, counts: {}, built: false, countSeq: 0, navSeq: 0, noGoal: false }; // noGoal: the next Tasks tab opens filtered to the tasks that serve no goal (the Goals table's last row, #7717)
const $ = (id) => document.getElementById(id);

// A team no board has (a mistyped /team/<name>, #8848): the page says so and offers the way back, with none of a team's tabs, New goal or Add agent. Asked once per team of the page's life, with the same rule as
// the Artifacts route's 404 (#8821: BoardKnown), so a new empty team that exists keeps its page; a probe that fails (offline, a computer that does not answer) leaves the page as it was.
const missing = new Map(); // team key -> true (no such team) / false
export async function teamIsMissing(team) {
    if (missing.has(team)) return missing.get(team);
    try {
        const r = await boardFetch(team, '/artifacts?limit=1');
        const gone = r.status === 404 && (((await r.clone().json().catch(() => null)) || {}).code === 'board_not_found');
        if (r.ok || gone) missing.set(team, gone);
        return gone;
    } catch { return false; }
}
function drawMissing(on) {
    $('team-page-view')?.classList.toggle('team-page-no-team', on);
    const box = $('team-page-missing'); if (!box) return;
    box.hidden = !on;
    if (on) { $('team-page-missing-line').textContent = `No team named ${splitKey(S.team).name}`; }
}

const currentTeamPage = () => (S.team && $('team-page-view') && $('team-page-view').style.display !== 'none' ? { team: S.team, tab: S.tab } : null);

// ── the shell ────────────────────────────────────────────────────────────

function buildOnce() {
    if (S.built) return;
    S.built = true;
    const tabs = $('team-tabs');
    for (const t of TEAM_TABS) {
        const b = el('button', 'tab team-tab'); b.type = 'button'; b.id = `team-tab-${t}`; b.dataset.tab = t;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false'); b.setAttribute('aria-controls', `team-panel-${t}`); b.tabIndex = -1;
        b.append(el('span', 'team-tab-label', LABEL[t]), el('span', 'tab-count team-tab-count'));
        b.addEventListener('click', () => { goTab(t, { focus: false, user: true }); });
        tabs.append(b);
    }
    buildTabsMore(tabs);
    drawTabEdges = watchScrollCue(tabs);
    window.addEventListener('resize', () => { syncTabStop(); drawTabEdges(); });
    tabs.addEventListener('keydown', (e) => {
        const list = [...tabs.querySelectorAll('[role=tab]')].filter(b => b.getClientRects().length), i = list.indexOf(document.activeElement); // a phone's tabs behind More are not in the row
        if (i < 0) return;
        const to = { ArrowRight: (i + 1) % list.length, ArrowLeft: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        list[to].focus();
        goTab(list[to].dataset.tab, { focus: true, user: true }); // selection follows focus
    });
    $('team-page-health').addEventListener('click', () => { goTab('agents', { user: true }); });
    $('team-page-missing-back')?.addEventListener('click', () => { go({ view: 'agents' }); });
    $('team-page-add-agent').addEventListener('click', () => { window.showAddAgentToBoard?.(S.team, teamDir()); });
    $('team-page-settings').addEventListener('click', () => { openSettings(); });
    buildMore();
    buildStop();
    // A click or a tap that opens a page or the pane puts the focus on its heading by script: no ring for a pointer, the ring for a key (the dialogs' rule, quiet_focus.js).
    $('team-page-view').addEventListener('click', () => quietFocus($('team-page-view')), true);
}

/** A phone's tab row: the first four tabs, Goals, Agents, Tasks and Artifacts, then More (Knowledge, Board, Settings behind it): the row never scrolls sideways (the audit's point 5, #8572). The More button sits beside the tab list, not in it (it is a menu button, not a tab); on a desktop it is not drawn. */
function buildTabsMore(tabs) {
    const row = el('div', 'team-tabs-row'); row.id = 'team-tabs-row';
    tabs.replaceWith(row); row.append(tabs);
    const b = el('button', 'tab team-tab team-tab-more'); b.type = 'button'; b.id = 'team-tab-more';
    b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'team-tabs-more-menu'); b.setAttribute('aria-label', 'More tabs');
    b.append(el('span', 'team-tab-label', 'More'));
    const menu = el('div', 'menu team-more-menu team-tabs-more-menu'); menu.id = 'team-tabs-more-menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'More tabs');
    for (const t of PHONE_MORE) {
        const m = el('button', 'menu-item'); m.type = 'button'; m.setAttribute('role', 'menuitem'); m.dataset.tab = t;
        m.append(el('span', 'team-more-label', LABEL[t]), el('span', 'tab-count team-tab-count'));
        menu.append(m);
    }
    row.append(b, menu);
    b.addEventListener('click', async () => { syncTabsMore(); (await importOnce('./menu_button.js')).toggleMenu(b); }); // its keys (arrows, Escape, Tab) and outside click are the shared menu's
    menu.addEventListener('click', (e) => {
        const m = e.target.closest('[data-tab]'); if (!m) return;
        importOnce('./menu_button.js').then(x => x.closeMenus());
        goTab(m.dataset.tab, { focus: false, user: true }).then(() => $('team-tab-more')?.focus()); // the tab is not on a phone's row: the keyboard stays on More
    });
}

/** More follows the page: it is the current tab (underlined, named for it for a screen reader; its words stay "More", so the strip keeps its width from tab to tab) while one of its tabs is open, and its items carry the counts of their tabs. */
function syncTabsMore() {
    const b = $('team-tab-more'); if (!b) return;
    const here = PHONE_MORE.includes(S.tab) && !S.item ? S.tab : '';
    b.classList.toggle('is-current', !!here);
    b.setAttribute('aria-label', here ? `${LABEL[here]}, more tabs` : 'More tabs');
    for (const m of document.querySelectorAll('#team-tabs-more-menu [data-tab]')) {
        const c = document.querySelector(`#team-tab-${m.dataset.tab} .team-tab-count`), mine = m.querySelector('.team-tab-count');
        mine.textContent = c ? c.textContent : ''; mine.hidden = !c || c.hidden || !c.textContent;
        m.setAttribute('aria-current', m.dataset.tab === here ? 'true' : 'false');
        if (m.dataset.tab !== here) m.removeAttribute('aria-current');
    }
}

/** The folder the team works in: where an agent added to it starts. */
function teamDir() { return teamWorkDir(state.liveSessions, S.team); } // by the team's key: a team on another computer is "@server/name" and its sessions say the bare name (#9970)

// More: the board's own actions (Select, Export, Pause, Delete), moved here from the board view's hidden holder (message_board.html) while this page is on screen (they keep their ids and their handlers).
let moreOpen = false;
/** The team's settings, in a popout over the page (#8853): the header's Settings button and its phone More item. */
function openSettings() { importOnce('./team_settings_modal.js').then(m => m.openTeamSettings(S.team)).catch(e => console.error('team settings', e)); }

/** Stopping a team: one menu, the same words and the same actions as the team's row in the sidebar (Sleep Team or Wake Team, Reset Team, Kill All; the last two apart, each asks first). A wide header has the Stop button; a phone's has the same items in More (#10008, Beta Tester and Mobile tester). */
const teamAsleep = () => { const m = (state.liveSessions || []).filter(s => inTeam(s, S.team)); return m.length > 0 && m.every(s => s.sleeping); };
function stopItems() {
    const asleep = teamAsleep();
    const none = !(state.liveSessions || []).some(s => inTeam(s, S.team)); // a team with no live agent has nothing to put to sleep, reset or kill: say so, do not offer a button that does nothing (#10187)
    const why = none ? 'No agent of this team is running' : '';
    return [
        { key: 'sleep', label: asleep ? 'Wake Team' : 'Sleep Team', hint: asleep ? 'Starts the sleeping agents again' : 'Stops every agent for now; Wake Team starts them again', why, run: () => window.toggleTeamSleep?.(S.team, asleep ? 'wake' : 'sleep') },
        { key: 'reset', label: 'Reset Team', hint: 'Each agent starts again from its first instructions, in a new chat', danger: true, why, run: () => window.resetTeam?.(S.team) },
        { key: 'kill', label: 'Kill All', hint: 'Ends every agent now; their chats stay in History', danger: true, why, run: () => window.killBoard?.(S.team) },
    ];
}
/** The items in the Stop menu and in a phone's More (labels follow the team: asleep or not). */
function syncStop() {
    const menu = $('team-page-stop-menu'); if (!menu) return;
    const moreMenu = $('team-page-more-menu');
    for (const [host, cls] of [[menu, 'menu-item'], [moreMenu, 'menu-item team-more-add team-more-stop']]) {
        if (!host) continue;
        for (const old of host.querySelectorAll('[data-stop], .team-more-stop-sep')) old.remove();
        const items = stopItems();
        if (host === moreMenu) { const r = el('hr', 'overflow-menu-divider team-more-add team-more-stop-sep'); r.dataset.stop = 'sep'; host.append(r); }
        items.forEach((it, i) => {
            if (host === menu && it.danger && !items[i - 1]?.danger) { const r = el('hr', 'overflow-menu-divider'); r.dataset.stop = 'sep'; host.append(r); }
            const b = el('button', `${cls}${it.danger ? ' menu-item-danger' : ''}`); const label = el('span', 'menu-item-text', it.label); if (it.hint && !it.why) label.append(el('span', 'menu-item-hint', it.hint)); b.append(label); b.type = 'button'; b.dataset.stop = it.key; if (it.why) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = it.why; b.append(' ', el('span', 'overflow-menu-note', it.why)); } b.addEventListener('click', () => { if (it.why) return; importOnce('./menu_button.js').then(x => x.closeMenus()); it.run(); });
            host.append(b);
        });
    }
}
function buildStop() {
    const b = $('team-page-stop'); if (!b) return;
    b.addEventListener('click', async () => { syncStop(); (await importOnce('./menu_button.js')).toggleMenu(b); });
    syncStop();
}

function buildMore() {
    const host = $('team-page-actions');
    const b = el('button', 'btn team-page-more', 'More'); b.type = 'button'; b.id = 'team-page-more'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'team-page-more-menu');
    const menu = el('div', 'menu team-more-menu'); menu.id = 'team-page-more-menu'; menu.hidden = true; menu.setAttribute('aria-label', 'More team actions');
    const add = el('button', 'menu-item team-more-add', 'Add agent'); add.type = 'button'; add.id = 'team-page-more-add'; // a phone's header has one button: More, with Add agent first, then Settings
    add.addEventListener('click', () => { window.showAddAgentToBoard?.(S.team, teamDir()); });
    const settings = el('button', 'menu-item team-more-add team-more-settings', 'Settings'); settings.type = 'button'; settings.id = 'team-page-more-settings';
    settings.addEventListener('click', () => { openSettings(); });
    menu.append(add, settings);
    host.append(b, menu);
    const set = (open, { focus = false } = {}) => { moreOpen = open; menu.hidden = !open; b.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button:not([hidden])')?.focus(); else if (focus) b.focus(); };
    b.addEventListener('click', () => { syncStop(); set(!moreOpen); }); // the Stop items in it follow the team (asleep or not) each time it opens
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) set(false); });
    document.addEventListener('keydown', (e) => { if (moreOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(false, { focus: true }); } }, true);
    document.addEventListener('click', (e) => { if (moreOpen && !menu.contains(e.target) && !b.contains(e.target)) set(false); });
}
const BOARD_ACTIONS = ['mb-select-btn', 'mb-export-btn', 'mb-pause-btn', 'mb-delete-btn'];
function adoptBoardActions() {
    const menu = $('team-page-more-menu'); if (!menu) return;
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b && b.parentElement !== menu) { b.dataset.home = b.parentElement ? b.parentElement.id : ''; menu.append(b); } }
    const pause = $('mb-pause-btn'); // what Pause Board does, in words under it (Mobile tester, #10008): a title is no help on a phone
    if (pause && !$('mb-pause-note')) { const n = el('span', 'menu-note', /^Resume/.test(pause.textContent) ? 'Agents get messages again when you resume.' : 'Agents stop receiving new messages until you resume.'); n.id = 'mb-pause-note'; pause.after(n); pause.setAttribute('aria-describedby', 'mb-pause-note'); }
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b) b.style.display = ''; } // display-ok: the holder's markup hides these with an inline display:none, which message_board.js clears the same way
    const sel = $('mb-select-btn'); if (sel) sel.hidden = S.tab !== 'messages'; // selecting messages is the Messages tab's
}
function releaseBoardActions() {
    const home = $('mb-more-menu'); if (!home) return;
    for (const id of BOARD_ACTIONS) { const b = $(id); if (b && b.parentElement !== home) { home.append(b); b.hidden = false; } }
}

// ── the header: the team's name and one status ───────────────────────────

/** The header again (the board was renamed). */
export const refreshTeamHeader = () => { if (S.team) drawHeader(); };

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

const ATTENTION = ['needs_input', 'waiting']; // a person has to do something: an agent waiting for input; an ended agent (no live terminal) and a queued one (waiting for a slot) are not (#8271, UI/UX); // a waiting agent (a trust prompt, a question, an approval) needs a person (UI/UX, #7513)
function drawStatus(data) {
    const s = $('team-page-status'); if (!s) return;
    syncStop();
    if (!data || !Array.isArray(data.agents)) { s.textContent = ''; s.className = 'team-page-status'; return; } // kept in the page and empty: a live region that is shown and filled in one turn is not announced
    // a team with no agent has nothing to be well: a name no board has (a mistyped /team/<name>) said All well in green (#8839 c); say nothing
    if (!data.agents.length) { s.textContent = ''; s.className = 'team-page-status'; const hb = $('team-page-health'); if (hb) hb.hidden = true; return; }
    const n = data.agents.filter(a => ATTENTION.includes(a.availability)).length;
    const waking = wakingSince(S.team) > 0;
    // no signal yet, or (right after Wake, while the read still says so) still asleep: nothing says they are well (#10006), and a just-woken team is counted as it reports (#10052, #10359)
    const notYet = a => a.availability === 'unknown' || (waking && a.availability === 'sleeping');
    const unknown = data.agents.filter(notYet).length;
    const asleep = !waking && teamAsleep(); // every agent of the team asleep: "Asleep", not "All well" in green (Mobile tester, #10359)
    // Just woken from here: how many have reported so far, until all have (or two minutes pass), not only "waiting" (#10052).
    const wakingNow = unknown > 0 && !n && waking;
    if (!unknown) stopWaking(S.team);
    const text = asleep ? 'Asleep' : wakingNow ? `Waking the team: ${data.agents.length - unknown} of ${data.agents.length} agents have sent their first message.` : n ? `${n} ${n === 1 ? 'needs' : 'need'} attention` : unknown ? `${unknown === data.agents.length ? 'Waiting for first signal' : `${unknown} of ${data.agents.length} waiting for first signal`}. A signal is an agent's first message.` : 'All well';
    // When agents need attention the visible status is a button to the Agents tab (beside the live region, which keeps saying it and is then only for a screen reader: the button's name is not announced twice); "All well" is plain text.
    const b = $('team-page-health');
    if (b) {
        b.hidden = !n;
        if (n) { b.replaceChildren(Object.assign(el('span', 'team-status-dot'), {}), document.createTextNode(text)); b.firstChild.setAttribute('aria-hidden', 'true'); b.setAttribute('aria-label', `Team health: ${text}`); }
    }
    if (s.textContent === text) return; // the same words are not said again
    s.className = `team-page-status ${asleep ? 'unknown' : n ? 'needs sr-only' : unknown ? 'unknown' : 'well'}`; // Asleep takes the neutral dot, as waiting does
    const dot = el('span', 'team-status-dot'); dot.setAttribute('aria-hidden', 'true');
    s.replaceChildren(dot, document.createTextNode(text));
}

function drawCounts() {
    let widened = false;
    for (const t of TEAM_TABS) {
        const c = document.querySelector(`#team-tab-${t} .team-tab-count`); if (!c) continue;
        const n = S.counts[t];
        const text = n ? String(n) : ''; // no badge at zero or unknown: one rule for every tab
        if (c.textContent !== text) { c.textContent = text; widened = true; }
        c.hidden = !text;
        const label = $(`team-tab-${t}`).querySelector('.team-tab-label');
        // a space between the word and its count, so the tab is read "Goals 2"
        label.textContent = text ? `${LABEL[t]} ` : LABEL[t];
    }
    // the counts widen the tabs: when one changed, the selected tab is brought wholly into view again (its own count arrives after it was scrolled to, #8149), then the edges are drawn
    queueMicrotask(() => { if (widened) $(`team-tab-${S.tab}`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); drawTabEdges(); });
}

/** The counts on the tabs and the header's status: three light reads, repeated while the page is on screen.
 * Consume failed JSON replies too: discarding a Response leaves its stream alive across page visits (#8169). */
async function readCounts() {
    const team = S.team, seq = ++S.countSeq;
    if (!team) return;
    const knowledge = S.knowledgeFor === team ? null : (S.knowledgeFor = team, teamFetch(team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge`).then(async r => { const data = await r.json(); return r.ok ? data : null; }).catch(() => null)); // the Knowledge tab's count once per team, with the others (the notes are read again when the tab opens)
    const [goals, tasks, avail, kn] = await Promise.allSettled([
        boardFetch(team, '/goals?state=proposed,active,blocked,done,dropped&limit=200').then(async r => { const data = await r.json(); return r.ok ? data : null; }),
        boardFetch(team, '/tasks?counts=1').then(async r => { const data = await r.json(); return r.ok ? data : null; }),
        refreshTeamAvailability(team, true),
        knowledge,
    ]);
    if (seq !== S.countSeq || team !== S.team) return;
    const g = goals.value;
    if (g) S.counts.goals = (Array.isArray(g) ? g : g.goals || []).length;
    const t = tasks.value;
    if (t && Number.isFinite(t.total_open)) S.counts.tasks = t.total_open;
    if (avail.value && Array.isArray(avail.value.agents)) S.counts.agents = avail.value.agents.filter(a => a.availability !== 'archived').length; // as the sidebar group counts them (#10164)
    const k = kn.value;
    if (k && k.exists) S.counts.knowledge = ((k.index ? 1 : 0) + (Array.isArray(k.agents) ? k.agents.length : 0)) || null;
    drawStatus(avail.value);
    drawCounts();
}
// A Wake or a Sleep from here: the status is read and drawn at once, not at the next poll (#10359).
document.addEventListener('coral:team-sleep-changed', e => { if (S.team && e.detail && e.detail.team === S.team) readCounts(); });
function startCounts() {
    readCounts();
    if (S.timer) return;
    S.timer = pollEvery(() => { const v = $('team-page-view'); if (v && v.style.display !== 'none' && S.team) readCounts(); }, 30000);
}

// ── tabs ─────────────────────────────────────────────────────────────────

const panel = (t) => $(`team-panel-${t}`);

/** Which edges of the tab strip hide more tabs (it scrolls sideways when the tabs are wider than the window): the fade at that edge says so. */
let drawTabEdges = () => {}; // set when the strip is built: the one scroll cue (scroll_cue.js)

/** The strip is ONE Tab stop: the selected tab, or, when it is behind More on a phone (no box in the row), the row's first tab: otherwise no tab of the row is reachable by Tab and a keyboard user would get past the whole tablist (#8791: Board is behind More now). */
function syncTabStop() {
    const tabs = TEAM_TABS.map(t => $(`team-tab-${t}`)).filter(Boolean), shown = tabs.filter(b => b.getClientRects().length > 0);
    const selected = tabs.find(b => b.getAttribute('aria-selected') === 'true');
    for (const b of tabs) b.tabIndex = b === selected && shown.includes(b) ? 0 : -1;
    if (shown.length && !shown.some(b => b.tabIndex === 0)) shown[0].tabIndex = 0;
}

function markTab(tab) {
    for (const t of TEAM_TABS) {
        const b = $(`team-tab-${t}`), on = t === tab;
        b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
        panel(t).hidden = !on;
    }
    syncTabStop();
    $('team-panel-item').hidden = true;
    syncTabsMore();
    $(`team-tab-${tab}`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); // the selected tab is in view inside the strip (on load and on change); the fade's room is the strip's scroll padding
    drawTabEdges();
}

/** Choose a tab (the person pressed it, a key moved to it, or an address named it). */
export async function goTab(tab, { focus = false, user = false, item = 0, replace = false } = {}) {
    if (!TEAM_TABS.includes(tab)) tab = 'goals';
    S.navSeq++;
    closeDetailPane();
    leaveMessages(tab);
    closeItem(false);
    S.tab = tab; S.item = null;
    markTab(tab);
    adoptBoardActions();
    if (user || item) note(keyRoute('team', S.team, tab, item || null), { replace });
    S.itemPending = !!item; // a task is being opened: the Tasks list must not rewrite its address meanwhile (#8898)
    try { await fillTab(tab, item); } finally { S.itemPending = false; }
    if (focus) { const b = $(`team-tab-${tab}`); (b.getClientRects().length ? b : $('team-tab-more')).focus(); } // a tab behind More is not in the row
}

const teamHooks = () => ({
    openTask: (task) => openTask(S.team, task.id),
    openGoal: (id) => openGoalPage(id),
    onItem: (id) => { if (S.tab === 'goals' && !S.quiet) note(keyRoute('team', S.team, 'goals', id || null)); },
    onCount: (n) => { },
});

async function fillTab(tab, item = 0) {
    const team = S.team, host = panel(tab), seq = S.navSeq;
    const stale = () => seq !== S.navSeq || tab !== S.tab || team !== S.team; // another tab was chosen while this one's module loaded: it must not draw over the newer one
    try {
        if (tab === 'goals') {
            const m = await importOnce('./goals_view.js');
            if (stale()) return;
            m.showGoals(host, team, { page: true, hooks: { ...teamHooks(), onCount: (n) => { S.counts.goals = n; drawCounts(); } } });
            if (item) m.openGoalWhenKnown(item); else if (m.openGoalId()) { S.quiet = true; m.closeGoal(); S.quiet = false; }
        } else if (tab === 'tasks') {
            const m = await importOnce('./team_tasks_page.js');
            if (stale()) return;
            const noGoal = S.noGoal; S.noGoal = false;
            const query = S.tasksQuery; S.tasksQuery = '';
            await m.showTasks(host, team, { ...teamHooks(), noGoal, query, onCount: (n) => { S.counts.tasks = n; drawCounts(); },
                onFilters: (qs) => { if (!S.quiet && S.tab === 'tasks' && !S.item && !S.itemPending) note(keyRoute('team', S.team, 'tasks', null, qs), { replace: true }); } }); // the address keeps the filters (#7782)
            if (stale()) return;
            if (item) await openTaskById(item);
        } else if (tab === 'artifacts') {
            const m = await importOnce('./team_artifacts_page.js');
            if (stale()) return;
            m.showArtifacts(host, team, { onCount: (n, more) => { S.counts.artifacts = more ? `${n}+` : n; drawCounts(); } });
        } else if (tab === 'messages') {
            const m = await importOnce('./message_board.js');
            if (stale()) return;
            m.showBoardInPage(team, host, item || null);
            adoptBoardActions();
        } else if (tab === 'agents') {
            const m = await importOnce('./team_agents_page.js');
            if (stale()) return;
            await m.showAgents(host, team, { openAgent: (agent) => openAgentPage(agent), onCount: (n) => { S.counts.agents = n; drawCounts(); } });
        } else if (tab === 'knowledge') {
            const m = await importOnce('./team_knowledge_page.js');
            if (stale()) return;
            await m.showKnowledge(host, team, { onCount: (n) => { S.counts.knowledge = n || null; drawCounts(); } });
        }
    } catch (e) { console.error('team page tab', tab, e); host.textContent = ''; host.append(el('p', 'goals-note', 'This tab could not be shown. Reload the page and try again.')); }
}

function leaveMessages(nextTab) {
    if (nextTab === 'messages') return;
    importOnce('./message_board.js').then(m => m.leaveBoardPage?.()).catch(() => {});
}

// ── item pages ───────────────────────────────────────────────────────────

/** A board task always belongs to its team's Tasks tab. Ignore a read if navigation moved on. */
async function openTaskById(id) {
    const team = S.team, seq = S.navSeq;
    const m = await importOnce('./team_tasks_page.js');
    const host = $('team-panel-item');
    const full = await m.readTask(team, id);
    if (!full || seq !== S.navSeq || team !== S.team || S.tab !== 'tasks') return;
    const origin = panel('tasks');
    S.item = { kind: 'task', id, origin };
    // opened from a goal's task list: Back returns to that goal and says it (#8898); by address or from the Tasks tab it is the list
    const fromGoal = /^\/team\/.+\/goals\/\d+$/.test(String(history.state?.prev || '').split('?')[0]);
    const { shortLabel } = await importOnce('./inbox_back_label.js');
    const backLabel = fromGoal ? (shortLabel(history.state?.from) || 'Goal') : 'Tasks';
    origin.hidden = true;
    host.hidden = false;
    m.renderTaskPage(host, full, {
        project: S.team, backLabel,
        openGoal: (id) => { closeItem(false); openGoalPage(id); },
        openTask: (t) => openTask(S.team, t.id), // a follow-up listed on the task's page
        onBack: () => { if (fromGoal) { history.back(); focusGoalTask(full.id); } else closeItem(true); },
    });
    note(keyRoute('team', team, 'tasks', id));
}

/** An agent's page under the Agents tab's header: the same header and tabs, a link back that returns to the row. */
async function openAgentPage(agent) {
    const m = await importOnce('./team_agents_page.js');
    const host = $('team-panel-item'), origin = panel('agents');
    S.item = { kind: 'agent', id: agent.subscriber_id || agent.session_id || agent.name, origin };
    origin.hidden = true;
    host.hidden = false;
    m.renderAgentPage(host, agent, { onBack: () => closeItem(true) });
}

/** After Back from a task opened from a goal: the keyboard is on that task's row in the goal's column (on a phone, where the column is the next screen, on the Tasks button), never the heading (#7404, #8898). Waits for the goal to be drawn again. */
async function focusGoalTask(id) {
    for (let i = 0; i < 80; i++) {
        const target = document.querySelector(`#team-panel-goals .goal-list .dt-primary[data-task-id="${Number(id)}"]`);
        if (target && S.tab === 'goals') { target.focus(); return; }
        await new Promise(r => setTimeout(r, 50));
    }
}

function closeItem(restoreFocus) {
    if (!S.item) return;
    const { origin, id, kind } = S.item;
    S.item = null;
    $('team-panel-item').hidden = true;
    $('team-panel-item')._taskConversation?.destroy({ keepDrafts: true });
    $('team-panel-item')._taskConversation = null;
    $('team-panel-item').replaceChildren();
    origin.hidden = false;
    if (restoreFocus && kind === 'agent') importOnce('./team_agents_page.js').then(m => m.focusAgentRow(id));
    else if (restoreFocus) {
        note(keyRoute('team', S.team, 'tasks')); importOnce('./team_tasks_page.js').then(m => { if (!m.focusTaskRow(id)) $('team-tab-tasks')?.focus(); });
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
    S.noGoal = tab === 'tasks' && !!opts.noGoal;
    S.tasksQuery = tab === 'tasks' ? opts.query || '' : '';
    const changed = S.team !== team;
    if (changed) { S.team = team; S.counts = {}; S.item = null; S.knowledgeFor = ''; }
    state.selectedTeam = team; // the team on screen (the sidebar marks its row; the panels moved in read it)
    state.boardPageProject = team;
    state.currentBoardServer = splitKey(team).server;
    showView('team-page-view');
    buildOnce();
    if (changed) { // another team: the tables of the last one go, the moved-in panels and the board's column are drawn again for this one
        for (const t of ['goals', 'tasks', 'artifacts', 'agents', 'knowledge']) { const p = panel(t); p.removeAttribute('data-built'); p.replaceChildren(); }
        drawCounts(); drawStatus(null);
    }
    drawHeader();
    drawMissing(missing.get(team) === true);
    if (changed && !missing.has(team)) teamIsMissing(team).then(gone => { if (gone && S.team === team) { drawMissing(true); drawStatus(null); } });
    if (S.item) closeItem(false);
    if (!opts.silent) note(keyRoute('team', team, tab, opts.item || null), { replace: !!opts.replace, from: opts.from || '' });
    startCounts();
    await goTab(tab, { item: opts.item || 0 });
    return true;
}

/** The route changed under the page (Back, Forward, a link): show what it names without writing another address. */
export async function applyTeamRoute(team, tab, item, query = '') {
    S.quiet = true;
    try {
        if (S.team === team && currentTeamPage() && !item && S.item) { closeItem(false); }
        if (S.team === team && currentTeamPage() && S.tab === tab && !S.item) {
            if (tab === 'goals') { const m = await importOnce('./goals_view.js'); if (item) m.openGoalWhenKnown(item); else if (m.openGoalId()) m.closeGoal(); return true; }
        }
        return await openTeamPage(team, { tab, item, query, silent: true });
    } finally { S.quiet = false; }
}

/** Leave the page: the board's column goes back to its own page and the dock's panels back to the dock. */
function leaveTeamPage() {
    state.lastTeamTab = S.tab; // the tab it was on, for the way back from another tab (#10008)
    S.navSeq++;
    closeItem(false);
    closeDetailPane();
    releaseBoardActions();
    importOnce('./message_board.js').then(m => m.leaveBoardPage?.()).catch(() => {});
    S.team = ''; S.item = null;
}

// Another page on screen (an agent, Chats, Jobs): the team page lets go of what it borrowed.
onViewShown(id => { if (id !== 'team-page-view' && S.team) leaveTeamPage(); });

/** Leaving the team page for another page (an agent, a tab, a route): the team is no longer the one on screen. Resolves false when the person declines to discard unsaved settings,
 *  and the page stays. (This was the legacy team context's exit, which the page's team shared: one place now.) */
export async function exitTeamPage({ force = false } = {}) {
    if (!state.selectedTeam) return true;
    if (!force) {
        const { hasUnsavedTeamSettings, confirmTeamWorkspaceChange } = await importOnce('./team_working_mode.js');
        if (hasUnsavedTeamSettings() && !(await confirmTeamWorkspaceChange())) return false;
    }
    state.selectedTeam = null;
    setPreviewSession(state.currentSession?.type === 'live' ? state.currentSession.session_id : null);
    if (state.liveSessions?.length) renderLiveSessions(state.liveSessions); // the sidebar's team row is not marked any more
    document.dispatchEvent(new CustomEvent('coral:route-changed')); // the Saved list and its count are of the agent or team shown (#4792)
    return true;
}
