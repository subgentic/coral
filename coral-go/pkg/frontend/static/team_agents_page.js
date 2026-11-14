/* The team page's Agents tab (#7453 stage 3, UI/UX's Team view design): status chips with counts, one table of everyone on the board (Agent, Status, Doing, Provider and more), and an agent's own page.
 * A live row opens that agent's chat (local or a Hub computer's), by click or Enter, with no button of its own (#15857); an ended agent's or a terminal's row opens its page, where Resume is. "Remind <name>" is on the agent's own page and opens a small dialog (the message, a repeat, Remind): the message goes now as an @mention board message to the agent, and with a repeat the repeating reminder is set too; then "Reminded <name>."
 * in a polite status. An agent that already has a repeating reminder has Edit reminder and Remove reminder on its page. Everything drawn is built with the DOM and textContent: names, reasons and task titles are written by agents.
 * Lazy: team_page.js imports it. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { foldWayBack } from './way_back.js';
import { state } from './state.js';
import { boardFetch, inTeam, keyLabel, isCloud, splitKey } from './server_base.js';
import { pollEvery } from './overload.js';
import { OPERATOR_ID } from './utils.js';
import { refreshTeamAvailability, remindAgent, stopAgentReminder } from './team_availability.js';
await loadStyles('team_agent_details.css'); // the quiet Details link's rules load with the tab (#15857)
const { openRemindDialog, REPEATS } = await importOnce('./team_remind_dialog.js');
const { searchChip, readSearchLevels, openSearchAccess } = await importOnce('./search_access.js'); // how far an agent's chat search reaches (#11048)
const Toolbar = await importOnce('./team_toolbar.js'); // the one toolbar of the team tabs (#7717)
const { rowFocusTarget, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried

const DT = await importOnce('./data_table.js');
const { statusMark } = await importOnce('./status_mark.js'); // lazy like this page: a lazy module is loaded through importOnce (import_hygiene)
const { mountAgentReviewSettings } = await importOnce('./agent_review_settings.js');
let agentsTableState = DT.tableState();

// The chips: the statuses people look for first; any other status that has agents gets its own chip after them.
// One word for a working agent (#15830, design guidelines 4.5): Working covers busy and an idle agent whose task is started; the task number is in Doing. The strip keeps four (All, Working, Has a task, Sleeping); the other states are in a More select beside it.
const STRIP = ['working', 'has_task', 'sleeping'], MORE = ['available', 'queued', 'waiting', 'needs_input', 'offline', 'unavailable', 'unknown', 'archived'];
const BUCKET_WORD = { working: 'Working', has_task: 'Has a task', available: 'Free', queued: 'Queued', waiting: 'Waiting for work', needs_input: 'Needs input', sleeping: 'Sleeping', offline: 'Ended', archived: 'Archived', unavailable: 'Unavailable', unknown: 'Not reported' };
const MARK = { working: 'working', needs_input: 'waiting', sleeping: 'sleeping', offline: 'done', unavailable: 'failed' }; // any other state is the grey hollow dot
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
const bucket = (a) => { const v = a.availability || 'unknown'; return v === 'busy' || (v === 'task_idle' && startedTask(a)) ? 'working' : v === 'task_idle' ? 'has_task' : v; }; // exclusive: every agent is in one, so the counts add up
const statusWord = (a) => BUCKET_WORD[bucket(a)] || 'Not reported';
const statusNode = (a) => statusMark(MARK[bucket(a)] || 'idle', statusWord(a)); // the shared mark: a shape and a word, no blue
// dropAt is one of the steps data_table.css has (62, 52, 36, 28, 20, 16): 32 and 33 had no rule, so those two columns never gave way and a phone's Status chip and row broke (#14903). Open tasks and Time on current task (#14861, the Operator): the tasks assigned to the agent that are pending, in progress or in review (a link to the Tasks tab filtered to the agent), and how long it has had its task in progress (since the claim; a dash with none).
const openTasksOf = (a) => Number(a.open_tasks) || 0;
const claimedAt = (a) => { const t = a.task_since && a.availability !== 'sleeping' ? Date.parse(a.task_since) : NaN; return Number.isFinite(t) ? t : null; }; // a sleeping agent shows no running clock: a dash, not a time that keeps counting (walk 16 M10)
/** "1 h 12 m", "5 m", "2 d 3 h": the time the agent has had its current task, from the claim; '' when it has none. */
export function onTaskWords(a, now = Date.now()) {
    const at = claimedAt(a);
    if (at === null) return '';
    const mins = Math.max(0, Math.floor((now - at) / 60000));
    if (mins < 1) return '<1 m';
    if (mins < 60) return `${mins} m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return m ? `${h} h ${m} m` : `${h} h`;
    const d = Math.floor(h / 24), hh = h % 24;
    return hh ? `${d} d ${hh} h` : `${d} d`;
}
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
    for (const a of agents) count[bucket(a)] = (count[bucket(a)] || 0) + 1;
    const row = k => ({ key: k, label: BUCKET_WORD[k] || k, count: count[k] || 0 });
    const extra = Object.keys(count).filter(k => !STRIP.includes(k) && !MORE.includes(k)); // a state this page does not know yet still has a place
    return { strip: [{ key: 'all', label: 'All', count: agents.filter(a => a.availability !== 'archived').length }, ...STRIP.map(row)], more: [...MORE, ...extra].filter(k => count[k] || k === 'available').map(row) };
}

// ── the tab ──────────────────────────────────────────────────────────────

window.addEventListener('kill', () => { if (model.team) load(); }); // a kill from the sidebar or an agent's own page: the rows read the change at once
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

/** Resume an ended agent from its earlier chat: the same action as Continue this chat, Resume session in All chats (resume_ended.js), on the agent's page (#15294, #15857). Null when the server named no session to resume. */
function resumeButton(agent, cls, onDone) {
    const e = agent.ended_session; if (!e || agent.availability !== 'offline') return null;
    const b = btn(cls, 'Resume', null);
    b.setAttribute('aria-label', `Resume ${agent.name}`);
    b.addEventListener('click', async (ev) => {
        ev.stopPropagation(); b.disabled = true;
        const { showToast } = await importOnce('./utils.js');
        try {
            const { resumeEndedAgent } = await importOnce('./resume_ended.js');
            await resumeEndedAgent(splitKey(model.team).server, { agentType: e.agent_type, sid: e.session_id, name: agent.name }, splitKey(model.team).name);
            showToast(`${agent.name} is back in "${keyLabel(model.team)}".`);
            await load(); onDone?.();
        } catch (err) { showToast(err.message || `Could not resume ${agent.name}.`, true); b.disabled = false; }
    });
    return b;
}

/** The live session a row opens, or null (an ended agent, a terminal: no chat). */
function chatSessionOf(agent) { return agent.availability !== 'offline' && agent.agent_type !== 'terminal' ? sessionOf(agent) : null; }

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
    const byState = model.filter === 'all' ? all.filter(a => a.availability !== 'archived') : all.filter(a => bucket(a) === model.filter);
    const q = model.search.trim().toLowerCase();
    const shown = q ? byState.filter(a => `${a.name || ''} ${a.role || ''}`.toLowerCase().includes(q)) : byState;
    return [...shown].sort((x, y) => (isOrchestrator(y) - isOrchestrator(x)) || (rank(x) - rank(y)) || (sidebarIndex(x) - sidebarIndex(y)));
}

function drawChips(host) {
    const agents = (model.data && model.data.agents) || [];
    const chips = chipCounts(agents);
    if (model.filter !== 'all' && ![...chips.strip, ...chips.more].some(c => c.key === model.filter)) model.filter = 'all';
    // The one toolbar line (#7717): the search field and the status pills (one compact select when they do not fit); Add agent stays in the page header.
    host.append(Toolbar.build({
        id: 'team-agents-search', label: 'Search agents', placeholder: 'Search agents', value: model.search,
        onSearch: text => { model.search = text; draw(); },
        pills: { label: 'Show agents that are', current: model.filter, items: chips.strip, more: chips.more,
            onPick: key => { model.filter = key; draw(); root.querySelector(`.goals-chip[data-filter="${key}"]`)?.focus({ preventScroll: true }); say(`Showing ${visibleAgents().length} agent${visibleAgents().length === 1 ? '' : 's'}`); } },
    }));
}

function draw() {
    const body = root && root.querySelector('.team-agents-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? (a.closest('tr[data-key]')?.dataset.key && a.classList.contains('dt-primary') ? `row:${a.closest('tr').dataset.key}` : a.dataset.filter ? `chip:${a.dataset.filter}` : '') : '';
    body.replaceChildren();
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Retry', () => load())); body.append(f); }
    if (model.loading) { body.append(el('p', 'goals-note', 'Checking agents…')); return; }
    const data = model.data;
    if (!data) return;
    if (!data.agents.length) { body.append(el('div', 'empty-state empty-state-tight', 'No agents on this board yet.')); return; }
    drawChips(body);
    const ended = data.agents.filter(a => a.availability === 'offline').length; // the tab lists every member, the sidebar only the live ones: this says why they differ (#8271)
    const archived = data.agents.filter(a => a.availability === 'archived').length, live = data.agents.length - archived; // the same rule as the tab's badge and the sidebar group: an archived agent is told apart, not counted (#10369)
    body.append(el('p', 'goals-note team-agents-count', `${live} agent${live === 1 ? '' : 's'}${ended ? `, ${ended} ended` : ''}${archived ? `, +${archived} archived` : ''}`));
    const rows = visibleAgents(), searchShown = [...model.levels.values()].some(l => l && l.level && l.level !== 'own');
    body.append(DT.dataTable({
        label: `Agents, ${rows.length}`, rows, rowKey: ag => ag.subscriber_id || ag.session_id || ag.name, state: agentsTableState,
        open: (ag, tr) => { const session = chatSessionOf(ag); if (session) openChat(session); else hooks.openAgent?.(ag, tr.querySelector('.dt-primary')); }, // the row opens the agent's chat (#15857); an ended agent or a terminal has none, so its row opens its page (Resume is there)
        columns: [
            { key: 'agent', label: 'Agent', primary: true, width: 'grow', line: 1, field: 'name', sort: true,
                cell: ag => { const b = DT.primaryButton('', ''); b.classList.add('team-agent-name'); b.append(DT.avatar(ag.name)); const dot = el('span', `team-agent-dot team-agent-dot-${ag.availability === 'available' || ag.availability === 'busy' ? 'ok' : ag.availability === 'needs_input' ? 'ask' : 'quiet'}`); dot.setAttribute('aria-hidden', 'true'); dot.title = statusWord(ag); b.prepend(dot); b.append(el('span', 'team-agent-state sr-only', `, ${statusWord(ag)}`)); if (ag.availability === 'needs_input' || ag.availability === 'unavailable') { const ask = DT.chip(statusWord(ag), CLASS[ag.availability]); ask.classList.add('team-agent-ask'); ask.setAttribute('aria-hidden', 'true'); b.append(ask); } const more = el('button', 'team-agent-details dt-reveal', 'Details'); more.type = 'button'; more.setAttribute('aria-label', `Details for ${ag.name}`); more.addEventListener('click', e => { e.stopPropagation(); hooks.openAgent?.(ag, more); }); const cell = el('span', 'team-agent-namecell'); cell.append(b, more); return cell; } }, // the state as a dot by the name where the Status column has given way (a phone); a state that asks something of a person also keeps its word there, as a chip the dot already names for a screen reader (#9713)
            { key: 'status', label: 'Status', line: 2, width: '11rem', dropAt: 28, sort: true, sortValue: statusWord, cell: ag => statusNode(ag) },

            { key: 'doing', label: 'Doing', line: 2, width: '18rem', dropAt: 52, sort: true, sortValue: doingOf, cell: ag => { const t = doingOf(ag), span = el('span', null, t); if (t) span.title = t; return span; } }, // one line a row (Goal #79): the whole line is the tooltip
            { key: 'open', label: 'Open tasks', line: 2, width: '6rem', dropAt: 36, sort: true, align: 'end', sortValue: openTasksOf, cell: ag => { const n = openTasksOf(ag); if (!n) return '0'; const link = DT.link(String(n), () => importOnce('./nav.js').then(nav => importOnce('./routes.js').then(r => nav.go(r.keyRoute('team', model.team, 'tasks', null, new URLSearchParams({ agent: ag.name }).toString()))))); link.setAttribute('aria-label', `${n} open ${n === 1 ? 'task' : 'tasks'}: ${ag.name}`); return link; } },
            { key: 'onTask', label: 'Time on task', line: 2, width: '6.75rem', dropAt: 36, sort: true, align: 'end', sortValue: ag => claimedAt(ag) === null ? 0 : Date.now() - claimedAt(ag), blankLast: ag => claimedAt(ag) === null, cell: ag => { const w = onTaskWords(ag); if (w) return w; const none = el('span', null, '\u2014'); none.setAttribute('role', 'img'); none.setAttribute('aria-label', 'none'); return none; } }, // a row with no task is last under either order; its dash is named "none" for a screen reader
            { key: 'provider', label: 'Provider', line: 2, width: '6rem', dropAt: 36, tone: 'tertiary', sort: true, sortValue: providerOf, cell: providerOf },
            ...(searchShown ? [{ key: 'search', label: 'Search', line: 2, width: '12rem', dropAt: 52, tone: 'tertiary', cell: ag => searchChip((model.levels.get(ag.name) || {}).level) || '' }] : []), // a column only while some member is above "own": an empty one was drawn, clipped at the right edge of a phone's table as a stray "…" (#11128)
        ], oneLine: true, resize: true, sortBar: false,
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
    // Sleep team or Wake team: the rows say so now, not at the next poll (#12335).
    document.addEventListener('coral:team-sleep-changed', e => { if (e.detail && e.detail.team === model.team && root && root.isConnected) load(); });
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
    back.append(arrow, el('span', null, ' Agents'));
    back.addEventListener('click', () => ctx.onBack());
    const page = el('div', 'goals-page goals-table-page team-agent-page');
    const status = el('div', 'team-agents-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const h = el('h2', 'goals-detail-title', agent.name); h.tabIndex = -1; h.id = 'team-agent-title';
    const line = el('div', 'goals-detail-line'); line.append(statusNode(agent));
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
    const resume = resumeButton(agent, 'btn btn-primary', () => { const fresh = ((model.data && model.data.agents) || []).find(a => a.name === agent.name); if (fresh) renderAgentPage(host, fresh, ctx); }); if (resume) bar.append(resume); // the page reads the agent again once it is back (it was the row's Resume before, #15857)
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

