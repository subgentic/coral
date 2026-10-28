/* Automations (Goal #74; UI/UX #8862): Workflows and Jobs as one screen, built like the Inbox: the folders in the sidebar (view_list.js), each folder's page one table on the shared list toolbar
 * (inbox_toolbar.js: search, state pills, Filters), a job or a workflow opened in place with a way back to its folder. Loaded the first time the tab is shown (lazy_panels.js); scheduler.js, which
 * loads at startup, keeps the jobs (read, polled, the job's page and its actions) and workflows.js keeps the workflows' pages; this file draws the folders. Jobs and Workflows are the library;
 * Running now and Failed are the two that need attention: the jobs and workflows with a run going, and those whose last run failed (a run with no job of its own, an API one-off, is a row of Running now).
 *
 * The address follows what is on screen (/automations/<folder>[/<id>[/runs/<run>]]): a folder or an item is opened by going to its route, and the route handler (app_routes.js) calls
 * openAutomationsRoute, so a link, Back and a reload all end in the same place. */
import { go, note, backIs, currentRoute } from './nav.js';
import { registerActions, textOf } from './actions.js';
import { registerGroupSource, openGroupTable, refreshGroupTable } from './sidebar_groups.js';
import { setHidden } from './dom_write.js';
import { announceNotice } from './notifications.js';
import { importOnce } from './import_once.js';
import { jobList, onJobsChanged, refreshJobs, selectScheduledJob, openJobId, scheduleOf, nextOf } from './scheduler.js';
import { lastWords, lastChip, atWords, whenWords, failureWords, isExample } from './job_words.js';
import { liveRuns, onLiveRuns, selectLiveJobRun } from './live_jobs.js';
const DT = await importOnce('./data_table.js'); // a lazy module imports only what loads at startup (import_hygiene): these load with it
const VL = await importOnce('./view_list.js');
const IT = await importOnce('./inbox_toolbar.js');
const AF = await importOnce('./automation_filters.js');
const W = await importOnce('./workflows.js');
const AR = await importOnce('./automation_runs.js');

const $ = id => document.getElementById(id);
const FOLDERS = [
    { key: 'running', label: 'Running now', noun: ['run', 'runs'], search: 'Search what is running', attention: true },
    { key: 'failed', label: 'Failed', noun: ['item', 'items'], search: 'Search what failed', attention: true },
    { key: 'recent', label: 'Recent runs', noun: ['run', 'runs'], search: 'Search recent runs', attention: true },
    { key: 'jobs', label: 'Jobs', noun: ['job', 'jobs'], search: 'Search jobs' },
    { key: 'workflows', label: 'Workflows', noun: ['workflow', 'workflows'], search: 'Search workflows' },
];
const folderOf = key => FOLDERS.find(f => f.key === key) || null;
const routeOf = (folder, id, run) => ({ view: 'automations', folder, ...(id ? { id } : {}), ...(run ? { run } : {}) });

let mounted = false, folder = 'jobs', navKey = null, folders = null, opener = null;
const filters = new Map(), tableStates = new Map(), bars = new Map();
const filtersOf = key => { if (!filters.has(key)) filters.set(key, AF.loadFilters(key)); return filters.get(key); };
const stateOf = key => { if (!tableStates.has(key)) tableStates.set(key, DT.tableState()); return tableStates.get(key); };
const setFilters = (key, next) => { filters.set(key, next); AF.saveFilters(key, next); const input = $('automations-search'); if (input && folder === key) input.value = next.q; };

// ── The folders' items ───────────────────────────────────────────────────
const workflowNames = () => new Map(W.workflowList().map(w => [Number(w.id), String(w.name || '')]));
const nameOfWorkflow = id => workflowNames().get(Number(id)) || '';
const allJobs = () => jobList().map(j => AF.jobItem(j, nameOfWorkflow));
const usedBy = id => jobList().filter(j => Number(j.workflow_id) === Number(id)).length;
const allWorkflows = () => W.workflowList().map(w => AF.workflowItem(w, usedBy(w.id)));
/** The runs with no job of their own (an API one-off: POST /api/tasks/run) that are going now: a row of Running now that opens the run's agent. */
const oneOffRuns = () => liveRuns().filter(r => !r.job_id).map(r => ({ kind: 'run', id: `run-${r.id}`, name: r.display_name || (r.job_name && r.job_name !== '__oneshot__' ? r.job_name : `Job run ${r.id}`), enabled: true, run: r,
    result: 'running', runs: '', agent: String(r.agent_type || ''), does: '', stepTypes: [], at: 0, last: Date.parse(r.started_at || '') || 0, live: r }));
const liveJobIds = () => new Set(liveRuns().filter(r => r.job_id).map(r => Number(r.job_id)));
/** What needs attention: the jobs and workflows with a run going (their own last run, or the websocket's live run), and those whose last run failed. */
const runningItems = () => { const live = liveJobIds(); return [...allJobs().filter(i => i.result === 'running' || live.has(i.id)), ...allWorkflows().filter(i => i.result === 'running'), ...oneOffRuns()]; };
const failedItems = () => [...allJobs(), ...allWorkflows()].filter(i => i.result === 'failed');
/** Every run of every job and workflow, newest first (automation_runs.js), as items the folder's filters match: the Result filter and the search by name. */
const recentItems = () => AR.recentRuns().map(r => ({ ...r, id: r.key, enabled: true, runs: '', agent: '', does: '', stepTypes: [], last: r.atMs })); // at stays the run's start time (a string: the Started column)
const ITEMS = { jobs: allJobs, workflows: allWorkflows, running: runningItems, failed: failedItems, recent: recentItems };
const folderFilters = key => { const f = filtersOf(key); return folderOf(key).attention && f.sort === 'next' ? { ...f, sort: 'last' } : f; }; // what needs attention is read newest first unless the person chose an order
const rowsOf = key => AF.ordered(ITEMS[key]().filter(i => AF.matches(i, filtersOf(key))), folderFilters(key));
const runsWords = i => i.runs === 'workflow' ? `Workflow ${nameOfWorkflow(i.job.workflow_id) || i.job.workflow_id}` : `Agent prompt (${AF.AGENT_LABEL[i.agent] || i.agent})`;
const stepsWords = i => `${i.stepCount} step${i.stepCount === 1 ? '' : 's'}`;
const usedByWords = i => (i.usedBy ? `${i.usedBy} job${i.usedBy === 1 ? '' : 's'}` : 'No jobs');
const countOf = key => (key === 'recent' ? AR.unreadCount() : ITEMS[key]().length); // Recent runs counts the runs not opened yet, the others their rows

// ── The folders ──────────────────────────────────────────────────────────
const sections = () => [{ title: 'Needs attention', items: FOLDERS.filter(f => f.attention).map(f => ({ key: f.key, label: f.label, count: countOf(f.key), alert: f.key === 'failed' })) },
    { title: 'Library', items: FOLDERS.filter(f => !f.attention).map(f => ({ key: f.key, label: f.label, count: countOf(f.key) })) }];
function renderNav(force = false) {
    const list = $('automations-nav-list');
    if (!list) return;
    const key = JSON.stringify([folder, sections(), filtersOf('jobs'), filtersOf('workflows'), filtersOf('running'), filtersOf('failed'), openJobId(), W.openWorkflowId(), liveRuns().map(r => r.id), filtersOf('recent'), AR.recentRuns().map(r => [r.key, r.run.status, AR.isUnread(r)]),
        rowsOf('jobs').map(i => [i.id, i.name, i.enabled, i.at, i.run && i.run.status, i.run && i.run.id, runsWords(i)]), rowsOf('workflows').map(i => [i.id, i.name, i.enabled, i.stepCount, i.usedBy, i.run && i.run.status, i.run && i.run.id])]);
    if (!force && key === navKey) return;
    navKey = key;
    if (folders && list.contains(folders)) VL.update(folders, { sections: sections(), current: folder });
    else { folders = VL.build({ id: 'automations-folders', label: 'Automations folders', sections: sections(), current: folder, onPick: pickFolder }); list.replaceChildren(folders); }
    setHidden(document.querySelector('.sidebar-header[data-header="automations"] [data-group-toggle]'), true); // folders do not fold: the collapse-all button has nothing to fold
    refreshGroupTable('automations');
}
function pickFolder(key) { if (folderOf(key)) go(routeOf(key)); }

/** Which folder is on screen: the sidebar's search box is named for it and holds its text. */
function setFolder(key) {
    if (!folderOf(key)) key = 'jobs';
    folder = key;
    const input = $('automations-search'), f = folderOf(key);
    if (input) {
        if (input.getAttribute('aria-label') !== f.search) input.setAttribute('aria-label', f.search);
        if (input.value !== filtersOf(key).q) input.value = filtersOf(key).q;
    }
}

// ── A folder's toolbar and table ─────────────────────────────────────────
const resultClass = run => run.status === 'failed' ? 'team-state-bad' : run.status === 'running' ? 'goal-state-task-active' : run.status === 'completed' && run.exit_reason !== 'ended_while_coral_was_down' ? 'goal-state-task-done' : '';
const resultSelect = key => ({ type: 'select', key: 'result', id: `automations-${key}-result`, label: 'Result', values: AF.RESULTS, labels: AF.RESULT_LABEL, any: 'Any result' });
const FIELDS = {
    running: () => [],
    failed: () => [],
    recent: () => [resultSelect('recent')],
    jobs: () => [resultSelect('jobs'),
        { type: 'select', key: 'runs', id: 'automations-jobs-runs', label: 'Runs', values: AF.RUNS, labels: AF.RUNS_LABEL, any: 'Anything' },
        { type: 'select', key: 'agent', id: 'automations-jobs-agent', label: 'Agent', values: AF.AGENTS, labels: AF.AGENT_LABEL, any: 'Any agent' }],
    workflows: () => [resultSelect('workflows'),
        { type: 'select', key: 'step', id: 'automations-workflows-step', label: 'Step type', values: AF.STEP_TYPES, labels: AF.STEP_LABEL, any: 'Any step' }],
};
const button = (label, action, cls = 'btn btn-primary', icon = '') => {
    const b = document.createElement('button'); b.type = 'button'; b.className = `${cls} automations-act${icon ? ' automations-act-icon' : ''}`.trim(); b.setAttribute('data-on-click', action);
    b.setAttribute('aria-label', label); // a phone draws a "+" or an icon: the name stays whole
    if (icon) { const i = document.createElement('span'); i.className = 'material-icons'; i.setAttribute('aria-hidden', 'true'); i.textContent = icon; b.append(i, ' '); }
    const text = document.createElement('span'); text.className = 'automations-act-text'; text.textContent = label; b.append(text); return b;
};
/** Running now and Failed create either kind: a New button with a menu of the two (the shared menu button: ArrowDown, Escape, a choice closes it). */
function newMenu() {
    const box = document.createElement('span'); box.className = 'automations-create gt-menu';
    const toggle = button('New', ''); toggle.id = 'automations-new-btn'; toggle.setAttribute('data-on-click', 'automations-new-toggle'); // the action's name is spelled out where the markup is made (action_census)
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'automations-new-menu');
    const menu = document.createElement('div'); menu.id = 'automations-new-menu'; menu.className = 'menu team-more-menu list-bar-more-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'New'); menu.hidden = true;
    for (const [label, action] of [['New job', 'job-new'], ['New workflow', 'wf-create']]) { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item'; b.textContent = label; b.setAttribute('data-on-click', action); b.setAttribute('role', 'menuitem'); menu.append(b); }
    box.append(toggle, menu);
    return box;
}
/** The create actions at the toolbar's right: New job, or New workflow with Build with Agent beside it (the agent that builds a workflow with you). */
function createAction(key) {
    if (key === 'jobs') return button('New job', 'job-new');
    if (folderOf(key).attention) return newMenu();
    const box = document.createElement('span'); box.className = 'automations-create';
    box.append(button('Build with Agent', 'wf-build-agent', 'btn', 'smart_toy'), button('New workflow', 'wf-create'));
    return box;
}
function toolbarOf(key) {
    const f = folderOf(key);
    if (!bars.has(key)) {
        bars.set(key, IT.folderToolbar({
            idp: `automations-${key}`, noun: f.noun[0], searchLabel: f.search,
            sorts: { values: AF.SORTS, labels: AF.SORT_LABEL, aria: `Sort ${f.noun[1]}` },
            fields: FIELDS[key](),
            model: { EMPTY: AF.EMPTY, clean: AF.clean, chips: AF.chips, isFiltered: AF.isFiltered, without: AF.without },
        }, next => { setFilters(key, next); renderNav(true); }));
    }
    const filt = filtersOf(key), rows = ITEMS[key]().filter(i => AF.matches(i, { ...filt, state: '' }));
    const counts = AF.STATES.map(s => rows.filter(i => i.enabled === (s === 'active')).length);
    const node = bars.get(key).draw({
        filters: filt,
        pills: f.attention ? null : { label: `Show ${f.noun[1]} that are`, current: filt.state || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...AF.STATES.map((s, i) => ({ key: s, label: AF.STATE_LABEL[s], count: counts[i] }))],
            onPick: pick => { setFilters(key, { ...filtersOf(key), state: pick === 'all' ? '' : pick }); renderNav(true); } },
        action: createAction(key),
    });
    return { node, signature: JSON.stringify([filt, counts, rows.length]) };
}

/** An item of Running now or Failed: a job's or a workflow's page, or a one-off run's agent. */
const openItem = i => {
    if (i.kind === 'run') { if (i.run.session_id) selectLiveJobRun(i.run.session_id, i.run.agent_type || 'claude'); return; }
    openRow(i.kind === 'workflow' ? 'workflows' : 'jobs', i, itemKey(i));
};
const openRow = (key, i, rowKey = i.id) => { const t = $('group-table-view'); opener = { key: rowKey, scroll: t ? t.scrollTop : 0 }; go(routeOf(key, i.id)); };
const lastRunCell = i => {
    const c = lastChip(i.run);
    if (!c) return 'Never run';
    const chip = DT.chip(c.word, resultClass(i.run));
    if (c.detail) chip.title = c.detail;
    return chip;
}; // one chip word, as the Runs table and the Workflows list say it (#9456); the reason a run failed to start is the tooltip
const workflowResult = i => W.lastResult(i.run);
/** A row's name button: the name is the one line; what the item is or runs is its tooltip (the page has it in full). */
const nameButton = (i, what) => {
    const b = DT.primaryButton(i.name); if (what) b.title = `${i.name} \u2014 ${what}`;
    if (!isExample(i.kind === 'job' ? i.job && i.job.description : i.kind === 'workflow' ? i.does : '')) return b;
    const w = DT.el('span', 'dt-name-example'); w.append(b, DT.tag('Example')); return w; // one added as an example is marked, so nobody takes it for their own (#10001)
};
/** A job's Last run; a paused job also says Paused beside it when its Next column (where the chip is) has gone, in a narrow list (#10275: a phone's Jobs list did not say which job was paused). */
const jobLastCell = i => {
    const base = lastRunCell(i);
    if (i.enabled) return base;
    const cell = DT.el('span', 'dt-title-cell'), chip = DT.chip('Paused');
    chip.classList.replace('dt-chip', 'dt-paused-name'); // not a .dt-chip: the Last run and Next columns' chips are what the table's own tests count
    cell.append(base, chip);
    return cell;
};
const KIND_WORD = { job: 'Job', workflow: 'Workflow', run: 'One-off' };
const itemKey = i => (i.kind === 'run' ? i.id : `${i.kind}-${i.id}`); // a job and a workflow can share a number
const scheduleWords = i => (i.kind === 'job' ? scheduleOf(i.job) : 'No schedule');
const whatWords = i => (i.kind === 'job' ? runsWords(i) : i.kind === 'workflow' ? stepsWords(i) : '');
function nextCell(i) {
    if (i.kind !== 'job') return 'Not scheduled';
    const cell = i.enabled ? DT.el('span', 'dt-time', nextOf(i.job)) : DT.chip('Paused');
    if (i.enabled && i.job.next_fire_at) { cell.title = `Next run ${atWords(i.job.next_fire_at)} your time`; cell.append(DT.el('span', 'sr-only', `, next run ${atWords(i.job.next_fire_at)} your time`)); } // also as text: a tooltip is not read, and a touch screen has none (#9117)
    return cell;
}
function lastCell(i, withReason = false) {
    if (i.kind === 'job') {
        const chip = lastRunCell(i), why = withReason ? failureWords(i.run) : '';
        if (!why || typeof chip === 'string') return chip;
        // Failed: the chip and, beside it on the same line, why in words (the run has it; the list showed only "Failed", #9965)
        const cell = DT.el('span', 'dt-last-run'); const reason = DT.el('span', 'dt-reason', why); reason.title = why;
        cell.append(chip, ' ', reason);
        return cell;
    }
    if (i.kind === 'workflow') return i.run ? DT.chip(workflowResult(i) || 'Run', resultClass(i.run)) : 'Never run';
    return DT.chip('running now', resultClass(i.run));
}
/** A first visit (no job and no workflow yet) starts with two choices, in whichever folder it lands (#9297, the audit's 2). */
const firstRun = () => countOf('jobs') === 0 && countOf('workflows') === 0 ? { cards: [
    { title: 'Run a prompt on a schedule', text: 'An agent does the same task at the times you pick.', action: 'job-new' },
    { title: 'Run steps from a workflow', text: 'Shell commands and agent steps that run one after another.', action: 'wf-create' },
] } : {};
/** A run of Recent runs: its job's page, or its workflow's run page. Opening it is what clears its dot. */
function openRun(i) {
    AR.markSeen(i);
    const t = $('group-table-view'); opener = { key: i.key, scroll: t ? t.scrollTop : 0 };
    go(AR.runRoute(i));
}
/** Recent runs: every run, newest first, one line each: the run's name (a dot before it while unread), what it is, its result, when it started and how long it took. */
function recentTable(rows, narrowed) {
    return { title: 'Recent runs', noun: ['run', 'runs'], rows,
        empty: { line: narrowed ? 'No run matches the search and filters.' : 'Nothing has run yet.', hint: narrowed ? '' : 'Every run of a job or workflow shows here, newest first. A dot marks one you have not opened.', ...(narrowed ? {} : firstRun()) },
        signature: JSON.stringify([!!firstRun().cards, rows.map(i => [i.key, i.run.status, AR.isUnread(i), i.name, AR.resultWords(i.run).full])]),
        node: () => DT.dataTable({
            label: `Recent runs, ${rows.length}`, rows, oneLine: true, rowKey: i => i.key, rowName: i => `${i.name}, ${AR.resultWords(i.run).full}${AR.isUnread(i) ? ', not opened' : ''}`, state: stateOf('recent'), open: openRun,
            columns: [ // one line a row (Goal #79): a narrow list drops Kind (under 52 rem: the run's name is at least 24 characters, #9856), then When it started and How long it took (dropAt, #8931): the name and the result stay, the name whole
                { key: 'name', label: 'Run', primary: true, width: 'grow', sort: true, sortValue: i => i.name, cell: i => {
                    const b = nameButton(i, i.kind === 'workflow' ? 'A workflow run' : 'A job run');
                    if (AR.isUnread(i)) { b.prepend(DT.el('span', 'automations-unread', ''), DT.el('span', 'sr-only', 'Not opened: ')); b.querySelector('.automations-unread').setAttribute('aria-hidden', 'true'); }
                    return b;
                } },
                { key: 'kind', label: 'Kind', width: '7rem', dropAt: 52, sort: true, sortValue: i => i.kind, cell: i => DT.tag(i.kind === 'workflow' ? 'Workflow' : 'Job') },
                { key: 'result', label: 'Result', width: '7rem', sort: true, sortValue: i => AR.resultWords(i.run).word, cell: i => { const w = AR.resultWords(i.run), c = DT.chip(w.word, resultClass(i.run)); c.title = w.full; return c; } },
                { key: 'started', label: 'Started', width: '7rem', dropAt: 28, tone: 'tertiary', sort: 'date', sortValue: i => i.atMs, firstDir: 'desc', cell: i => DT.el('span', 'dt-time', whenWords(i.at)) },
                { key: 'took', label: 'Took', width: '6rem', dropAt: 28, tone: 'tertiary', sort: 'date', sortValue: i => (i.finishedAt ? Date.parse(i.finishedAt) - i.atMs : -1), cell: i => AR.tookWords(i.at, i.finishedAt) },
            ],
        }).el };
}
/** Running now and Failed: the jobs and workflows together, one table, the same five columns in both. */
function attentionTable(key, rows, narrowed) {
    const f = folderOf(key), failed = key === 'failed';
    return { title: f.label, noun: f.noun, rows,
        empty: { line: narrowed ? `No ${f.noun[0]} matches the search.` : failed ? 'Nothing has failed.' : 'Nothing is running.', hint: narrowed ? '' : failed ? 'A job or workflow whose last run failed shows here.' : 'A job or workflow with a run going shows here.', ...(narrowed ? {} : firstRun()) },
        signature: JSON.stringify([!!firstRun().cards, rows.map(i => [i.kind, i.id, i.name, i.run && i.run.status, i.run && i.run.id, i.kind === 'job' ? nextOf(i.job) : ''])]),
        node: () => DT.dataTable({
            label: `${f.label}, ${rows.length}`, rows, oneLine: true, rowKey: itemKey, rowName: i => i.name, state: stateOf(key), open: openItem,
            columns: [ // one line a row (Goal #79): what it is goes to the name's tooltip, and a narrow list drops Schedule, then Kind, then Next (dropAt, #8931)
                { key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, sortValue: i => i.name, cell: i => nameButton(i, whatWords(i)) },
                { key: 'kind', label: 'Kind', width: '7rem', dropAt: 36, sort: true, sortValue: i => KIND_WORD[i.kind], cell: i => DT.tag(KIND_WORD[i.kind]) },
                { key: 'schedule', label: 'Schedule', width: '12rem', dropAt: 52, sort: true, sortValue: scheduleWords, cell: scheduleWords },
                { key: 'last-run', label: 'Last run', width: failed ? '24rem' : '12rem', dropAt: 16, tone: 'tertiary', sort: 'date', sortValue: i => i.last, cell: i => lastCell(i, failed) },
                { key: 'next', label: 'Next', width: '7rem', dropAt: 28, tone: 'tertiary', sort: 'date', sortValue: i => (i.kind === 'job' && i.enabled ? i.job.next_fire_at : ''), cell: nextCell },
            ],
        }).el };
}
let _gone = '', _goneTimer = 0; // 'Deleted greet-hourly.': the Jobs page says a job it returns from was deleted, for a while, in place of a toast that would cover its first control (#9298)
/** The Jobs page says a job was deleted, under its title, for twelve seconds. */
export function noteJobDeleted(name) {
    _gone = `Deleted ${name}.`; clearTimeout(_goneTimer);
    announceNotice(_gone); // the line arrives already filled, which a screen reader does not reliably say: the notices' own live region says it
    _goneTimer = setTimeout(() => { _gone = ''; renderNav(true); }, 12000);
}
function folderTable(key) {
    const f = folderOf(key), rows = rowsOf(key), filt = filtersOf(key), narrowed = AF.isFiltered(filt) || filt.q;
    if (key === 'recent') return recentTable(rows, narrowed);
    if (f.attention) return attentionTable(key, rows, narrowed);
    const base = { title: f.label, noun: f.noun, rows, status: key === 'jobs' ? _gone : '',
        empty: { line: narrowed ? `No ${f.noun[0]} matches the search and filters.` : `No ${f.noun[1]} yet.`, hint: narrowed ? '' : key === 'jobs' ? 'New job schedules one.' : 'Build with Agent starts an agent that builds one with you; New workflow opens an empty form. A workflow runs when you press Run, when a job schedules it, or through the API.', ...(narrowed ? {} : firstRun()) } };
    if (key === 'jobs') {
        return { ...base, signature: JSON.stringify([_gone, !!firstRun().cards, rows.map(i => [i.job, lastWords(i.run), nextOf(i.job), runsWords(i)])]),
            node: () => DT.dataTable({
                label: `Jobs, ${rows.length}`, rows, oneLine: true, wrapNames: true, rowKey: i => i.id, rowName: i => i.name, state: stateOf(key), open: i => openRow(key, i),
                columns: [ // one line a row (Goal #79): what the job runs is the name's tooltip and its page's; a narrow list drops Schedule, then Next (dropAt, #8931)
                    { key: 'job', label: 'Job', primary: true, width: 'grow', sort: true, sortValue: i => i.name, cell: i => nameButton(i, runsWords(i)) },
                    { key: 'schedule', label: 'Schedule', width: '12rem', dropAt: 36, sort: true, sortValue: i => scheduleOf(i.job), cell: i => scheduleOf(i.job) },
                    { key: 'last-run', label: 'Last run', width: '12rem', dropAt: 16, tone: 'tertiary', sort: 'date', sortValue: i => i.run && i.run.started_at, cell: jobLastCell },
                    { key: 'next', label: 'Next', width: '7rem', dropAt: 28, tone: 'tertiary', sort: 'date', sortValue: i => (i.enabled ? i.job.next_fire_at : ''), cell: i => {
                        const cell = i.enabled ? DT.el('span', 'dt-time', nextOf(i.job)) : DT.chip('Paused');
                        if (i.enabled && i.job.next_fire_at) { cell.title = `Next run ${atWords(i.job.next_fire_at)} your time`; cell.append(DT.el('span', 'sr-only', `, next run ${atWords(i.job.next_fire_at)} your time`)); } // also as text (#9117)
                        return cell;
                    } },
                ],
            }).el };
    }
    return { ...base, signature: JSON.stringify([!!firstRun().cards, rows.map(i => [i.wf, i.usedBy, workflowResult(i)])]),
        node: () => DT.dataTable({
            label: `Workflows, ${rows.length}`, rows, oneLine: true, wrapNames: true, rowKey: i => i.id, rowName: i => i.name, state: stateOf(key), open: i => openRow(key, i),
            columns: [ // one line a row (Goal #79): the description is the name's tooltip and the page's; a narrow list drops Steps, then Used by (dropAt, #8931)
                { key: 'workflow', label: 'Workflow', primary: true, width: 'grow', sort: true, sortValue: i => i.name, cell: i => nameButton(i, i.does) },
                { key: 'steps', label: 'Steps', width: '6rem', dropAt: 36, tone: 'tertiary', sort: 'number', sortValue: i => i.stepCount, cell: stepsWords },
                { key: 'last-run', label: 'Last run', width: '14rem', dropAt: 16, sort: 'date', sortValue: i => i.run && i.run.started_at, cell: i => {
                    if (!i.run) return 'Never run';
                    const cell = DT.el('span'); cell.append(DT.chip(workflowResult(i) || 'Run', resultClass(i.run)));
                    if (i.run.started_at) { cell.title = `Last run ${whenWords(i.run.started_at)}`; cell.append(DT.el('span', 'sr-only', `, last run ${whenWords(i.run.started_at)}`)); } // also as text (#9117)
                    return cell;
                } },
                { key: 'used-by', label: 'Used by', width: '7rem', dropAt: 28, tone: 'tertiary', sort: 'number', sortValue: i => i.usedBy, cell: usedByWords },
            ],
        }).el };
}

registerGroupSource('automations', {
    signature: () => JSON.stringify([folder]),
    toolbar: key => (folderOf(key) ? toolbarOf(key) : null),
    keys: () => FOLDERS.map(f => f.key),
    redraw: () => renderNav(true),
    table: key => (folderOf(key) ? folderTable(key) : null),
    lead: () => ({ signature: JSON.stringify([folder, sections()]), node: () => VL.build({ id: 'automations-folders-page', label: 'Automations folders', sections: sections(), current: folder, onPick: pickFolder }) }), // a phone: the folders are one select on top of the table
    isEmpty: () => false, // the tab opens its folder itself (showAutomationsTab)
    showList: () => window.switchNavTab?.('automations'),
    empty: () => window.switchNavTab?.('automations'),
});

// ── Showing the tab, a folder or an item ─────────────────────────────────
function mount() {
    if (mounted) return;
    mounted = true;
    onJobsChanged(() => renderNav());
    W.onWorkflowsChanged(() => renderNav());
    onLiveRuns(() => { renderNav(); AR.refreshRuns(); });
    AR.onRunsChanged(() => renderNav());
    AR.startRuns();
    W.refreshWorkflows();
}

/** Called by switchNavTab('automations'): the folders are drawn and the folder that was on screen opens, unless an item's page is the address (the route handler opens that). */
export function showAutomationsTab() {
    mount();
    renderNav(true);
    refreshJobs();
    AR.refreshRuns(true);
    if (document.body.getAttribute('data-nav-tab') !== 'automations') return; // the module arrived after the person had moved on
    if (/^\/automations\/[a-z]+\/\d/.test(window.location.pathname)) return; // an item's page is the address: its route opens it
    const named = /^\/automations\/([a-z]+)\/?$/.exec(window.location.pathname); // a folder's address: that folder, not the one that was last on screen
    if (named && folderOf(named[1])) folder = named[1];
    $('scheduler-view')?.removeAttribute('data-phone-item');
    $('workflows-view')?.removeAttribute('data-phone-item');
    setFolder(folder);
    const at = currentRoute();
    note(routeOf(folder), { replace: !!at && at.view === 'automations' && !at.folder }); // the tab's click wrote /automations: the folder's address takes its place, one entry for one click
    openGroupTable('automations', folder);
}

/** The route handler's call (app_routes.js): the folder, or the job, workflow or run, the address names. false when the item is not there. */
export async function openAutomationsRoute(r) {
    mount();
    renderNav(true);
    const key = folderOf(r.folder) ? r.folder : folder;
    if (r.id && key === 'jobs') {
        await refreshJobs();
        if (!jobList().some(j => Number(j.id) === r.id)) return false;
        W.leaveWorkflowPage();
        setFolder(key);
        await selectScheduledJob(r.id);
        renderNav(true);
        return true;
    }
    if (r.id && key === 'workflows') {
        setFolder(key);
        const found = r.run ? await W.selectWorkflowRun(r.run, { workflowId: r.id }) : await W.selectWorkflow(r.id);
        renderNav(true);
        return found !== false;
    }
    W.leaveWorkflowPage();
    refreshJobs();
    AR.refreshRuns(true);
    W.refreshWorkflows();
    $('scheduler-view')?.removeAttribute('data-phone-item');
    setFolder(key);
    openGroupTable('automations', key);
    const row = opener && $('group-table-view')?.querySelector(`tr[data-key="${CSS.escape(String(opener.key))}"] .dt-primary`);
    if (row) { row.focus({ preventScroll: true }); $('group-table-view').scrollTop = opener.scroll; opener = null; }
    return true;
}

/** An item's page (or a deleted item's) goes back to its folder: one step back when the entry before is the folder, else the folder's address. */
export function backToFolder(key) {
    const open = key === 'workflows' ? W.openWorkflowId() : openJobId();
    if (!opener && open) opener = { key: open, scroll: 0 }; // the item that was open gets the keyboard back, however it was opened
    const route = routeOf(folderOf(key) ? key : 'jobs'), prev = history.state && history.state.prev;
    if (backIs(route) || (typeof prev === 'string' && /^\/automations\/[a-z]+\/?$/.test(prev))) history.back(); else go(route); // back to the folder the item was opened from (Failed, say), else to its own
}

/** The sidebar's search box was typed in (app_actions.js): it narrows the folder on screen, and the page's box shows the same words. */
export function filterAutomations(value) { setFilters(folder, { ...filtersOf(folder), q: String(value || '').trim() }); renderNav(true); }

registerActions({
    'automations-back': el => backToFolder(textOf(el.dataset.folder)),
    'automations-new-toggle': el => { importOnce('./menu_button.js').then(m => m.toggleMenu(el)).catch(() => {}); }, // Running now and Failed make either kind: the New button's menu
});
