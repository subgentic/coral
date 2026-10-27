/* Automations (Goal #74; UI/UX #8862): Workflows and Jobs as one screen, built like the Inbox: the folders in the sidebar (view_list.js), each folder's page one table on the shared list toolbar
 * (inbox_toolbar.js: search, state pills, Filters), a job or a workflow opened in place with a way back to its folder. Loaded the first time the tab is shown (lazy_panels.js); scheduler.js, which
 * loads at startup, keeps the jobs (read, polled, the job's page and its actions) and workflows.js keeps the workflows' pages; this file draws the folders. Jobs and Workflows are the library;
 * Running now and Failed join them in a later commit.
 *
 * The address follows what is on screen (/automations/<folder>[/<id>[/runs/<run>]]): a folder or an item is opened by going to its route, and the route handler (app_routes.js) calls
 * openAutomationsRoute, so a link, Back and a reload all end in the same place. */
import { go, note, backIs } from './nav.js';
import { registerActions, textOf } from './actions.js';
import { registerGroupSource, openGroupTable, refreshGroupTable } from './sidebar_groups.js';
import { setHidden } from './dom_write.js';
import { importOnce } from './import_once.js';
import { jobList, onJobsChanged, refreshJobs, selectScheduledJob, openJobId, scheduleOf, nextOf } from './scheduler.js';
import { lastWords, atWords, whenWords } from './job_words.js';
const DT = await importOnce('./data_table.js'); // a lazy module imports only what loads at startup (import_hygiene): these load with it
const VL = await importOnce('./view_list.js');
const IT = await importOnce('./inbox_toolbar.js');
const AF = await importOnce('./automation_filters.js');
const W = await importOnce('./workflows.js');

const $ = id => document.getElementById(id);
const FOLDERS = [
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
const ITEMS = { jobs: allJobs, workflows: allWorkflows };
const rowsOf = key => AF.ordered(ITEMS[key]().filter(i => AF.matches(i, filtersOf(key))), filtersOf(key));
const runsWords = i => i.runs === 'workflow' ? `Workflow ${nameOfWorkflow(i.job.workflow_id) || i.job.workflow_id}` : `Agent prompt (${AF.AGENT_LABEL[i.agent] || i.agent})`;
const stepsWords = i => `${i.stepCount} step${i.stepCount === 1 ? '' : 's'}`;
const usedByWords = i => (i.usedBy ? `${i.usedBy} job${i.usedBy === 1 ? '' : 's'}` : 'No jobs');
const countOf = key => ITEMS[key]().length;

// ── The folders ──────────────────────────────────────────────────────────
const sections = () => [{ title: 'Library', items: FOLDERS.map(f => ({ key: f.key, label: f.label, count: countOf(f.key) })) }];
function renderNav(force = false) {
    const list = $('automations-nav-list');
    if (!list) return;
    const key = JSON.stringify([folder, sections(), filtersOf('jobs'), filtersOf('workflows'), openJobId(), W.openWorkflowId(),
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
    jobs: () => [resultSelect('jobs'),
        { type: 'select', key: 'runs', id: 'automations-jobs-runs', label: 'Runs', values: AF.RUNS, labels: AF.RUNS_LABEL, any: 'Anything' },
        { type: 'select', key: 'agent', id: 'automations-jobs-agent', label: 'Agent', values: AF.AGENTS, labels: AF.AGENT_LABEL, any: 'Any agent' }],
    workflows: () => [resultSelect('workflows'),
        { type: 'select', key: 'step', id: 'automations-workflows-step', label: 'Step type', values: AF.STEP_TYPES, labels: AF.STEP_LABEL, any: 'Any step' }],
};
const button = (label, action, cls = 'btn btn-primary', icon = '') => {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.setAttribute('data-on-click', action);
    if (icon) { const i = document.createElement('span'); i.className = 'material-icons'; i.setAttribute('aria-hidden', 'true'); i.textContent = icon; b.append(i, ' '); }
    b.append(label); return b;
};
/** The create actions at the toolbar's right: New job, or New workflow with Build with Agent beside it (the agent that builds a workflow with you). */
function createAction(key) {
    if (key === 'jobs') return button('New job', 'job-new');
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
        pills: { label: `Show ${f.noun[1]} that are`, current: filt.state || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...AF.STATES.map((s, i) => ({ key: s, label: AF.STATE_LABEL[s], count: counts[i] }))],
            onPick: pick => { setFilters(key, { ...filtersOf(key), state: pick === 'all' ? '' : pick }); renderNav(true); } },
        action: createAction(key),
    });
    return { node, signature: JSON.stringify([filt, counts, rows.length]) };
}

const openRow = (key, i) => { const t = $('group-table-view'); opener = { key: i.id, scroll: t ? t.scrollTop : 0 }; go(routeOf(key, i.id)); };
const lastRunCell = i => (i.run ? DT.chip(lastWords(i.run), resultClass(i.run)) : lastWords(null));
const workflowResult = i => W.lastResult(i.run);
function folderTable(key) {
    const f = folderOf(key), rows = rowsOf(key), filt = filtersOf(key), narrowed = AF.isFiltered(filt) || filt.q;
    const base = { title: f.label, noun: f.noun, rows,
        empty: { line: narrowed ? `No ${f.noun[0]} matches the search and filters.` : `No ${f.noun[1]} yet.`, hint: narrowed ? '' : key === 'jobs' ? 'New job schedules one.' : 'Build with Agent starts an agent that builds one with you; New workflow opens an empty form. A workflow runs when you press Run, when a job schedules it, or through the API.' } };
    if (key === 'jobs') {
        return { ...base, signature: JSON.stringify(rows.map(i => [i.job, lastWords(i.run), nextOf(i.job), runsWords(i)])),
            node: () => DT.dataTable({
                label: `Jobs, ${rows.length}`, rows, layout: 'fixed', rowKey: i => i.id, rowName: i => i.name, state: stateOf(key), open: i => openRow(key, i),
                columns: [
                    { key: 'job', label: 'Job', primary: true, width: 'grow', line: 1, sort: true, sortValue: i => i.name, cell: i => DT.primaryButton(i.name), subtitle: runsWords },
                    { key: 'schedule', label: 'Schedule', width: '12rem', line: 2, sort: true, sortValue: i => scheduleOf(i.job), cell: i => scheduleOf(i.job) },
                    { key: 'last-run', label: 'Last run', width: '9rem', line: 2, tone: 'tertiary', sort: 'date', sortValue: i => i.run && i.run.started_at, cell: lastRunCell },
                    { key: 'next', label: 'Next', width: '7rem', line: 1, tone: 'tertiary', sort: 'date', sortValue: i => (i.enabled ? i.job.next_fire_at : ''), cell: i => {
                        const cell = i.enabled ? DT.el('span', 'dt-time', nextOf(i.job)) : DT.chip('Paused');
                        if (i.enabled && i.job.next_fire_at) cell.title = `Next run ${atWords(i.job.next_fire_at)} your time`;
                        return cell;
                    } },
                ],
            }).el };
    }
    return { ...base, signature: JSON.stringify(rows.map(i => [i.wf, i.usedBy, workflowResult(i)])),
        node: () => DT.dataTable({
            label: `Workflows, ${rows.length}`, rows, layout: 'fixed', rowKey: i => i.id, rowName: i => i.name, state: stateOf(key), open: i => openRow(key, i),
            columns: [
                { key: 'workflow', label: 'Workflow', primary: true, width: 'grow', line: 1, sort: true, sortValue: i => i.name, cell: i => DT.primaryButton(i.name), subtitle: i => i.does },
                { key: 'steps', label: 'Steps', width: '6rem', line: 2, tone: 'tertiary', sort: 'number', sortValue: i => i.stepCount, cell: stepsWords },
                { key: 'last-run', label: 'Last run', width: '14rem', line: 2, sort: 'date', sortValue: i => i.run && i.run.started_at, cell: i => {
                    if (!i.run) return 'Never run';
                    const cell = DT.el('span'); cell.append(DT.chip(workflowResult(i) || 'Run', resultClass(i.run)));
                    if (i.run.started_at) cell.title = `Last run ${whenWords(i.run.started_at)}`;
                    return cell;
                } },
                { key: 'used-by', label: 'Used by', width: '7rem', line: 2, tone: 'tertiary', sort: 'number', sortValue: i => i.usedBy, cell: usedByWords },
                { key: 'run', label: 'Run', width: '4rem', line: 2, cell: i => { // a workflow can be run from its row, as before (its page has Run too)
                    const b = DT.el('button', 'btn btn-small dt-action', 'Run'); b.type = 'button'; b.setAttribute('aria-label', `Run ${i.name}`);
                    b.addEventListener('click', () => W.triggerWorkflow(i.id, b));
                    return b;
                } },
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
    W.refreshWorkflows();
}

/** Called by switchNavTab('automations'): the folders are drawn and the folder that was on screen opens, unless an item's page is the address (the route handler opens that). */
export function showAutomationsTab() {
    mount();
    renderNav(true);
    refreshJobs();
    if (document.body.getAttribute('data-nav-tab') !== 'automations') return; // the module arrived after the person had moved on
    if (/^\/automations\/[a-z]+\/\d/.test(window.location.pathname)) return; // an item's page is the address: its route opens it
    const named = /^\/automations\/([a-z]+)\/?$/.exec(window.location.pathname); // a folder's address: that folder, not the one that was last on screen
    if (named && folderOf(named[1])) folder = named[1];
    $('scheduler-view')?.removeAttribute('data-phone-item');
    $('workflows-view')?.removeAttribute('data-phone-item');
    setFolder(folder);
    note(routeOf(folder));
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
    const route = routeOf(folderOf(key) ? key : 'jobs');
    if (backIs(route)) history.back(); else go(route);
}

/** The sidebar's search box was typed in (app_actions.js): it narrows the folder on screen, and the page's box shows the same words. */
export function filterAutomations(value) { setFilters(folder, { ...filtersOf(folder), q: String(value || '').trim() }); renderNav(true); }

registerActions({ 'automations-back': el => backToFolder(textOf(el.dataset.folder)) });
