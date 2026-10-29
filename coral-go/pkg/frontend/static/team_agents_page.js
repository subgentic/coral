/* The team page's Agents tab (#7453 stage 3, UI/UX's Team view design): status chips with counts, one table of everyone on the board (Agent, Status, Doing, Provider, Chat), and an agent's own page.
 * Each live row has "Open chat" (that agent's chat, local or a Hub computer's; none for an ended agent or a terminal). "Remind <name>" is on the agent's own page and opens a small dialog (the message, a repeat, Remind): the message goes now as an @mention board message to the agent, and with a repeat the repeating reminder is set too; then "Reminded <name>."
 * in a polite status. An agent that already has a repeating reminder has Edit reminder and Remove reminder on its page. Everything drawn is built with the DOM and textContent: names, reasons and task titles are written by agents.
 * Lazy: team_page.js imports it. */
import { importOnce } from './import_once.js';
import { foldWayBack } from './way_back.js';
import { state } from './state.js';
import { boardFetch, inTeam, keyLabel, isCloud } from './server_base.js';
import { pollEvery } from './overload.js';
import { OPERATOR_ID } from './utils.js';
import { refreshTeamAvailability, remindAgent, stopAgentReminder } from './team_availability.js';
const { openRemindDialog, REPEATS } = await importOnce('./team_remind_dialog.js');
const { searchChip, readSearchLevels, openSearchAccess } = await importOnce('./search_access.js'); // how far an agent's chat search reaches (#11048)
const Toolbar = await importOnce('./team_toolbar.js'); // the one toolbar of the team tabs (#7717)
const { rowFocusTarget, stateChip, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried

const DT = await importOnce('./data_table.js');
const { mountAgentReviewSettings } = await importOnce('./agent_review_settings.js');
let agentsTableState = DT.tableState();

const WORD = { available: 'Free', busy: 'Busy', task_idle: 'Task assigned, idle', queued: 'Queued', waiting: 'Waiting', needs_input: 'Needs input', sleeping: 'Sleeping', archived: 'Archived', offline: 'Ended', unknown: 'No signal yet', unavailable: 'Unavailable' };
// The chips: the statuses people look for first; any other status that has agents gets its own chip after them.
const FIRST = ['available', 'busy', 'queued', 'sleeping', 'offline'];
const CHIP_WORD = { available: 'Free', unknown: 'Unknown', task_idle: 'Has a task' }; // an idle agent with a task, started or not: its row says which ("Working on #1" or "Task assigned, idle"), so the filter does not repeat one of the two
const CLASS = { available: 'goal-state-done', busy: 'goal-state-active', needs_input: 'goal-state-blocked', unavailable: 'team-state-bad' }; // the colours of the goals' own states; Sleeping and the rest stay quiet
const PROVIDER = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', pi: 'Pi', terminal: 'Terminal' };

const model = { team: '', data: null, levels: new Map(), filter: 'all', search: '', failed: '', loading: false };
let root = null, hooks = {};
const subscribed = new Set(); // teams the operator is already subscribed to on this page, so a Remind is one write
let itemStatus = null; // the agent page's own live region while that page is on screen: the tab's is hidden then and would not be read
const say = (t) => { const s = itemStatus && itemStatus.isConnected && !itemStatus.closest('[hidden]') ? itemStatus : root && root.querySelector('.team-agents-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

// One status per agent (#10603, the Beta tester): an agent that is idle with a task already in progress is working on it, not "Task assigned, idle" beside "#1 in progress".
const startedTask = (a) => (a.tasks || []).find(t => t.status === 'in_progress');
const statusWord = (a) => (a.availability === 'task_idle' && startedTask(a) ? `Working on #${Number(startedTask(a).id)}` : WORD[a.availability] || 'No signal yet');
const providerOf = (a) => PROVIDER[a.agent_type] || (a.agent_type ? a.agent_type.charAt(0).toUpperCase() + a.agent_type.slice(1) : 'Claude');
const canRemind = (a) => a.availability !== 'offline' && (a.agent_type !== 'terminal' || a.reminder); // a reminder to an ended agent does nothing (#8271) // a terminal is not an agent: a reminder to it does nothing (UI audit #5589)
// A task nobody has picked up says what it waits on (#10200): the agent it is for, not just "pending".
// the tasks it waits on, when it waits on any (#10222); one on another board is named with its board (#10287), as its number alone would read as a task of this team
const waitsOn = (t) => [...(Array.isArray(t.waiting_on) ? t.waiting_on : []).map(n => `#${Number(n)}`), ...(Array.isArray(t.waiting_on_elsewhere) ? t.waiting_on_elsewhere : []).map(b => `${keyLabel(String(b.board_id || ''))} #${Number(b.id)}`)].join(', ');
const taskLine = (t, a) => `#${Number(t.id)} ${(t.status === 'pending' || t.status === 'blocked') && waitsOn(t) ? `waiting on ${waitsOn(t)}` : t.status === 'pending' && a && a.name ? `waiting for ${a.name} to pick it up` : String(t.status || '').replaceAll('_', ' ')}: ${t.title}`;
/** What the agent is doing: its first task as one line, else the reason its status gives. */
const doingOf = (a) => (a.tasks && a.tasks.length ? taskLine(a.tasks[0], a) + (a.tasks.length > 1 ? ` (+${a.tasks.length - 1} more)` : '') : (a.reason || ''));

/** The statuses with at least one agent, in the order of the chips, with their counts. */
function chipCounts(agents) {
    const count = {};
    for (const a of agents) count[a.availability || 'unknown'] = (count[a.availability || 'unknown'] || 0) + 1;
    const keys = [...FIRST, ...Object.keys(count).filter(k => !FIRST.includes(k))].filter(k => count[k] || k === 'available');
    return [['all', 'All', agents.filter(a => a.availability !== 'archived').length], ...keys.map(k => [k, CHIP_WORD[k] || WORD[k] || k, count[k] || 0])];
}

// ── the tab ──────────────────────────────────────────────────────────────

async function load() {
    const team = model.team; if (!team) return;
    if (!model.data) { model.loading = true; draw(); }
    try {
        const data = await refreshTeamAvailability(team, true);
        if (team !== model.team) return;
        if (!data || !Array.isArray(data.agents)) throw new Error('no answer');
        model.data = data; model.failed = '';
        model.levels = await readSearchLevels(team);
        hooks.onCount?.(data.agents.filter(a => a.availability !== 'archived').length); // the sidebar group lists a team's live agents and keeps an archived one in its own section: the tab says the same number (#10164); the Archived chip still finds it
    } catch (e) {
        if (team !== model.team) return;
        model.failed = 'The agents could not be read.';
    }
    model.loading = false;
    draw();
}

/** Send the reminder: the message now, as an @mention board message to the agent; with a repeat, also the repeating reminder (POST /reminder). Resolves to { ok, error }. */
async function sendReminder(agent, { message, seconds }) {
    const name = agent.name, team = model.team;
    try {
        if (!subscribed.has(team)) {
            const r = await boardFetch(team, '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, job_title: 'Operator' }) });
            if (r.ok) subscribed.add(team);
        }
        const r = await boardFetch(team, '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content: `@${name} ${message}` }) });
        if (!r.ok) { const b = await r.json().catch(() => ({})); return { ok: false, error: `Could not remind ${name}: ${b && b.error ? b.error : `HTTP ${r.status}`}` }; }
        let every = '';
        if (seconds > 0) {
            const rr = await boardFetch(team, '/reminder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: agent.subscriber_id || name, message, interval_seconds: seconds }) });
            if (!rr.ok) { const b = await rr.json().catch(() => ({})); return { ok: false, error: `${name} was reminded, but the repeat was not set: ${b && b.error ? b.error : `HTTP ${rr.status}`}` }; }
            every = (REPEATS.find(x => x[0] === seconds) || [])[2] || '';
        }
        say(`Reminded ${name}${every ? ` and ${every}` : ''}.`);
        if (every) load();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `Could not remind ${name}: ${e && e.message ? e.message : 'no answer'}` };
    }
}

const askRemind = (agent, opener) => openRemindDialog(agent.name, { opener, onSend: (v) => sendReminder(agent, v) });

/** The agent's chat: its live session, local or a Hub computer's; null when it has none (an ended agent, a terminal). */
const openChat = (session) => { window.switchNavTab?.('agents'); window.selectLiveSession?.(session.name, session.agent_type, session.session_id, session.server, { focusChat: true }); };

/** "Remove from this board" (#11112, the Operator's clean-up of a leftover seat): DELETE /api/board/{team}/seats/{subscriber}, after a confirm. The agent keeps running; it just has no seat on this board. The route is the Operator's alone and never goes through the Hub, so the button is not drawn there. */
function removeSeatButton(agent, ctx) {
    const b = btn('btn btn-danger', 'Remove from this board', null);
    b.setAttribute('aria-label', `Remove ${agent.name} from this board`);
    b.addEventListener('click', async () => {
        const { showConfirmModal } = await importOnce('./confirm_dialog.js');
        const { showToast } = await importOnce('./utils.js');
        showConfirmModal('Remove from this board', `Take ${agent.name}'s seat off ${keyLabel(model.team)}? It stops getting this board's messages and tasks and can no longer post to it. The agent itself keeps running.`, async () => {
            try {
                const r = await boardFetch(model.team, `/seats/${encodeURIComponent(agent.subscriber_id)}`, { method: 'DELETE' });
                if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(d.error || `Could not remove ${agent.name} from the board`, true); return; }
                showToast(`${agent.name} was removed from the board`);
                await load(); ctx.onBack();
            } catch { showToast(`Could not remove ${agent.name} from the board`, true); }
        }, null, { label: 'Remove seat', danger: true });
    });
    return b;
}

function chatButton(agent) {
    const session = agent.availability !== 'offline' && agent.agent_type !== 'terminal' ? sessionOf(agent) : null;
    if (!session) return '';
    const b = btn('btn btn-small dt-action team-open-chat', 'Open chat');
    b.setAttribute('aria-label', `Open chat with ${agent.name}`); // one button per row, each named for whose
    b.addEventListener('click', (e) => { e.stopPropagation(); openChat(session); });
    return b;
}

// The Orchestrator first, then the agents that need a person (the header's "N need attention" opens this tab): a waiting agent, then a queued one, then an offline one; the rest in the sidebar's order.
const NEEDS = ['waiting', 'needs_input']; // an ended agent needs no one: it sorts with the rest (#8271)
const rank = (a) => { const i = NEEDS.indexOf(a.availability); return i < 0 ? NEEDS.length : i; };
const isOrchestrator = (a) => /orchestrator/i.test(`${a.role || ''} ${a.name || ''}`);
function sidebarIndex(a) {
    const live = (state.liveSessions || []).filter(s => inTeam(s, model.team));
    const i = live.findIndex(s => (a.session_id && s.session_id === a.session_id) || s.name === a.name);
    return i < 0 ? live.length : i;
}
function visibleAgents() {
    const all = (model.data && model.data.agents) || [];
    const byState = model.filter === 'all' ? all.filter(a => a.availability !== 'archived') : all.filter(a => (a.availability || 'unknown') === model.filter);
    const q = model.search.trim().toLowerCase();
    const shown = q ? byState.filter(a => `${a.name || ''} ${a.role || ''}`.toLowerCase().includes(q)) : byState;
    return [...shown].sort((x, y) => (isOrchestrator(y) - isOrchestrator(x)) || (rank(x) - rank(y)) || (sidebarIndex(x) - sidebarIndex(y)));
}

function drawChips(host) {
    const agents = (model.data && model.data.agents) || [];
    const chips = chipCounts(agents);
    if (!chips.some(c => c[0] === model.filter)) model.filter = 'all';
    // The one toolbar line (#7717): the search field and the status pills (one compact select when they do not fit); Add agent stays in the page header.
    host.append(Toolbar.build({
        id: 'team-agents-search', label: 'Search agents', placeholder: 'Search agents', value: model.search,
        onSearch: text => { model.search = text; draw(); },
        pills: { label: 'Show agents that are', current: model.filter, items: chips.map(([key, word, n]) => ({ key, label: word, count: n })),
            onPick: key => { model.filter = key; draw(); root.querySelector(`.goals-chip[data-filter="${key}"]`)?.focus({ preventScroll: true }); say(`Showing ${visibleAgents().length} agent${visibleAgents().length === 1 ? '' : 's'}`); } },
    }));
}

function draw() {
    const body = root && root.querySelector('.team-agents-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? (a.closest('tr[data-key]')?.dataset.key && a.classList.contains('dt-primary') ? `row:${a.closest('tr').dataset.key}` : a.dataset.filter ? `chip:${a.dataset.filter}` : '') : '';
    body.replaceChildren();
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Try again', () => load())); body.append(f); }
    if (model.loading) { body.append(el('p', 'goals-note', 'Checking agents…')); return; }
    const data = model.data;
    if (!data) return;
    if (!data.agents.length) { body.append(el('div', 'empty-state empty-state-tight', 'No agents on this board yet.')); return; }
    drawChips(body);
    const ended = data.agents.filter(a => a.availability === 'offline').length; // the tab lists every member, the sidebar only the live ones: this says why they differ (#8271)
    const archived = data.agents.filter(a => a.availability === 'archived').length, live = data.agents.length - archived; // the same rule as the tab's badge and the sidebar group: an archived agent is told apart, not counted (#10369)
    body.append(el('p', 'goals-note team-agents-count', `${live} agent${live === 1 ? '' : 's'}${ended ? `, ${ended} ended` : ''}${archived ? `, +${archived} archived` : ''}`));
    const rows = visibleAgents();
    body.append(DT.dataTable({
        label: `Agents, ${rows.length}`, rows, rowKey: ag => ag.subscriber_id || ag.session_id || ag.name, state: agentsTableState,
        open: (ag, tr) => hooks.openAgent?.(ag, tr.querySelector('.dt-primary')),
        columns: [
            { key: 'agent', label: 'Agent', primary: true, width: 'grow', line: 1, field: 'name', sort: true,
                cell: ag => { const b = DT.primaryButton('', ''); b.append(DT.avatar(ag.name)); const dot = el('span', `team-agent-dot team-agent-dot-${ag.availability === 'available' || ag.availability === 'busy' ? 'ok' : ag.availability === 'needs_input' ? 'ask' : 'quiet'}`); dot.setAttribute('aria-hidden', 'true'); dot.title = statusWord(ag); b.prepend(dot); b.append(el('span', 'team-agent-state sr-only', `, ${statusWord(ag)}`)); if (ag.availability === 'needs_input' || ag.availability === 'unavailable') { const ask = DT.chip(statusWord(ag), CLASS[ag.availability]); ask.classList.add('team-agent-ask'); ask.setAttribute('aria-hidden', 'true'); b.append(ask); } return b; } }, // the state as a dot by the name where the Status column has given way (a phone); a state that asks something of a person also keeps its word there, as a chip the dot already names for a screen reader (#9713)
            { key: 'status', label: 'Status', line: 2, width: '11rem', dropAt: 28, sort: true, sortValue: statusWord, cell: ag => DT.chip(statusWord(ag), CLASS[ag.availability]) },
            { key: 'doing', label: 'Doing', line: 2, width: '18rem', dropAt: 52, sort: true, sortValue: doingOf, cell: ag => { const t = doingOf(ag), span = el('span', null, t); if (t) span.title = t; return span; } }, // one line a row (Goal #79): the whole line is the tooltip
            { key: 'provider', label: 'Provider', line: 2, width: '6rem', dropAt: 36, tone: 'tertiary', sort: true, sortValue: providerOf, cell: providerOf },
            { key: 'search', label: 'Search', line: 2, width: '12rem', dropAt: 44, tone: 'tertiary', cell: ag => searchChip((model.levels.get(ag.name) || {}).level) || '' }, // only above "own": an empty column is not drawn
            { key: 'chat', label: 'Chat', line: 1, width: '7rem', cell: chatButton },
        ], oneLine: true, sortBar: false,
    }).el);
    if (held) { const sel = held.startsWith('row:') ? rowFocusTarget(body, held.slice(4)) : body.querySelector(`.goals-chip[data-filter="${CSS.escape(held.slice(5))}"]`); sel?.focus({ preventScroll: true }); }
}

// The tab keeps itself current, as Tasks does: when the window comes back to the front, and every 15 s while the tab is on screen.
let watching = false;
function refresh() {
    if (!root || !root.isConnected || root.closest('[hidden]') || document.hidden || model.loading) return;
    load();
}
function watch() {
    if (watching) return;
    watching = true;
    pollEvery(refresh, 15000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

/** Show the team's agents in `host`. hooks: onCount(n), openAgent(agent, opener). */
export function showAgents(host, team, h = {}) {
    if (team !== model.team) { agentsTableState = DT.tableState(); Object.assign(model, { team, data: null, filter: 'all', search: '', failed: '', loading: false }); }
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const page = el('div', 'goals-page goals-table-page');
        const status = el('div', 'team-agents-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        page.append(status, el('div', 'team-agents-body'));
        host.replaceChildren(page);
    }
    root = host.firstChild;
    draw();
    watch();
    return load();
}

/** Put the focus back on an agent's row (the agent page's back link). */
export function focusAgentRow(key) {
    const t = root && rowFocusTarget(root, key);
    if (t) t.focus({ preventScroll: true });
}

// ── an agent's page ──────────────────────────────────────────────────────

const fact = (dl, k, v) => { if (v == null || v === '') return; const d = el('div', 'goals-fact'); d.append(el('dt', null, k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = String(v); d.append(dd); dl.append(d); };

function sessionOf(agent) {
    const live = (state.liveSessions || []).filter(s => inTeam(s, model.team));
    return live.find(s => agent.session_id && s.session_id === agent.session_id) || live.find(s => s.name === agent.name) || null;
}

/** An agent's own page, under the Agents tab's header: back link, the name, status, what it does, and Remind and Open chat. ctx: { onBack }. */
export function renderAgentPage(host, agent, ctx) {
    host.replaceChildren();
    host.setAttribute('aria-label', agent.name);
    const back = el('button', 'back-link goals-back'); back.type = 'button';
    const arrow = el('span', 'goals-back-arrow', '←'); arrow.setAttribute('aria-hidden', 'true');
    back.append(arrow, document.createTextNode(' Agents'));
    back.addEventListener('click', () => ctx.onBack());
    const page = el('div', 'goals-page goals-table-page team-agent-page');
    const status = el('div', 'team-agents-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const h = el('h2', 'goals-detail-title', agent.name); h.tabIndex = -1; h.id = 'team-agent-title';
    const line = el('div', 'goals-detail-line'); line.append(stateChip(statusWord(agent), CLASS[agent.availability]));
    const dl = el('dl', 'facts goals-facts');
    fact(dl, 'Provider', providerOf(agent));
    fact(dl, 'Role', agent.role);
    fact(dl, 'Status', agent.reason);
    if (agent.tasks && agent.tasks.length) { const ul = el('ul', 'team-agent-tasks'); for (const t of agent.tasks) ul.append(el('li', null, taskLine(t, agent))); fact(dl, 'Working on', ul); }
    if (agent.reminder) fact(dl, 'Repeating reminder', agent.reminder_interval_seconds ? `every ${Math.round(agent.reminder_interval_seconds / 60)} min` : 'on');
    itemStatus = status;
    page.append(status, back, h, line, dl);
    const bar = el('div', 'goals-pinbar');
    if (canRemind(agent) && agent.agent_type !== 'terminal') {
        const b = btn('btn', 'Remind', null); b.setAttribute('aria-label', `Remind ${agent.name}`);
        b.addEventListener('click', () => askRemind(agent, b));
        bar.append(b);
    }
    const session = sessionOf(agent), reach = model.levels.get(agent.name);
    if (reach) { const c = searchChip(reach.level); if (c) line.append(c); const b = btn('btn', 'Search access\u2026', null); b.setAttribute('aria-label', `Search access for ${agent.name}`); b.addEventListener('click', () => openSearchAccess({ name: agent.name, team: model.team, ...reach }, { opener: b, onChanged: () => load().then(() => renderAgentPage(host, agent, ctx)) })); bar.append(b); }
    if (!isCloud() && !String(model.team).startsWith('@') && agent.subscriber_id) bar.append(removeSeatButton(agent, ctx)); // the Operator takes a seat off the board (#11112): on this computer only, never through the Hub
    if (session) bar.append(btn('btn', 'Open chat', () => openChat(session)));
    if (agent.reminder) {
        const id = agent.subscriber_id || agent.name;
        bar.append(btn('btn', 'Edit reminder', () => remindAgent(model.team, id, agent, () => load())), btn('btn', 'Remove reminder', async () => { if (await stopAgentReminder(model.team, id, () => load())) ctx.onBack(); }));
    }
    page.append(bar);
    foldWayBack(page, '.goals-back', '.goals-detail-title');
    host.append(page);
    if (agent.agent_type !== 'terminal') mountAgentReviewSettings(page, model.team, agent.subscriber_id || agent.name);
    h.focus({ preventScroll: true });
}

