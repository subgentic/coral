/* Automations (Goal #74; UI/UX #8862): Workflows and Jobs as one screen, built like the Inbox: the folders in the sidebar (view_list.js), each folder's page one table on the shared list toolbar
 * (inbox_toolbar.js: search, state pills, Filters), a job or a workflow opened in place with a way back to its folder. Loaded the first time the tab is shown (lazy_panels.js); scheduler.js, which
 * loads at startup, keeps the jobs (read, polled, the job's page and its actions) and this file draws them. Jobs is the first folder; Workflows, Running now and Failed join it commit by commit.
 *
 * The address follows what is on screen (/automations/<folder>[/<id>]): a folder or an item is opened by going to its route, and the route handler (app_routes.js) calls openAutomationsRoute, so a link,
 * Back and a reload all end in the same place. */
import { go, note, backIs } from './nav.js';
import { registerActions, textOf } from './actions.js';
import { registerGroupSource, openGroupTable, refreshGroupTable } from './sidebar_groups.js';
import { setHidden } from './dom_write.js';
import { importOnce } from './import_once.js';
import { jobList, onJobsChanged, refreshJobs, selectScheduledJob, openJobId, scheduleOf, nextOf } from './scheduler.js';
import { lastWords, atWords } from './job_words.js';
const DT = await importOnce('./data_table.js'); // a lazy module imports only what loads at startup (import_hygiene): these load with it
const VL = await importOnce('./view_list.js');
const IT = await importOnce('./inbox_toolbar.js');
const AF = await importOnce('./automation_filters.js');

const $ = id => document.getElementById(id);
const FOLDERS = [{ key: 'jobs', label: 'Jobs', noun: ['job', 'jobs'], search: 'Search jobs' }];
const folderOf = key => FOLDERS.find(f => f.key === key) || null;
const routeOf = (folder, id) => ({ view: 'automations', folder, ...(id ? { id } : {}) });

let mounted = false, folder = 'jobs', navKey = null, folders = null, jobBar = null, opener = null;
const filters = new Map(), tableStates = new Map();
const filtersOf = key => { if (!filters.has(key)) filters.set(key, AF.loadFilters(key)); return filters.get(key); };
const stateOf = key => { if (!tableStates.has(key)) tableStates.set(key, DT.tableState()); return tableStates.get(key); };
const setFilters = (key, next) => { filters.set(key, next); AF.saveFilters(key, next); const input = $('automations-search'); if (input && folder === key) input.value = next.q; };

// ── The jobs as items ────────────────────────────────────────────────────
let workflowNames = new Map(); // the workflows a job can run, by id: the name a job's row says it runs
async function readWorkflowNames() {
    try {
        const r = await fetch('/api/workflows');
        if (!r.ok) return;
        workflowNames = new Map(((await r.json()).workflows || []).map(w => [Number(w.id), String(w.name || '')]));
        renderNav(true);
    } catch { /* the rows say "Workflow" without the name until a read works */ }
}
const nameOfWorkflow = id => workflowNames.get(Number(id)) || '';
const allJobs = () => jobList().map(j => AF.jobItem(j, nameOfWorkflow));
const jobRows = () => AF.ordered(allJobs().filter(i => AF.matches(i, filtersOf('jobs'))), filtersOf('jobs'));
const runsWords = i => i.runs === 'workflow' ? `Workflow ${nameOfWorkflow(i.job.workflow_id) || i.job.workflow_id}` : `Agent prompt (${AF.AGENT_LABEL[i.agent] || i.agent})`;
const countOf = key => key === 'jobs' ? allJobs().length : undefined;

// ── The folders ──────────────────────────────────────────────────────────
const sections = () => [{ title: 'Library', items: FOLDERS.map(f => ({ key: f.key, label: f.label, count: countOf(f.key) })) }];
function renderNav(force = false) {
    const list = $('automations-nav-list');
    if (!list) return;
    const rows = jobRows();
    const key = JSON.stringify([folder, sections(), filtersOf('jobs'), rows.map(i => [i.id, i.name, i.enabled, i.at, i.run && i.run.status, i.run && i.run.id, runsWords(i)]), openJobId()]);
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

// ── The Jobs folder's page ───────────────────────────────────────────────
const resultClass = run => run.status === 'failed' ? 'team-state-bad' : run.status === 'running' ? 'goal-state-task-active' : run.status === 'completed' && run.exit_reason !== 'ended_while_coral_was_down' ? 'goal-state-task-done' : '';
function jobsToolbar() {
    if (!jobBar) {
        jobBar = IT.folderToolbar({
            idp: 'automations-jobs', noun: 'job', searchLabel: 'Search jobs',
            sorts: { values: AF.SORTS, labels: AF.SORT_LABEL, aria: 'Sort jobs' },
            fields: [
                { type: 'select', key: 'result', id: 'automations-jobs-result', label: 'Result', values: AF.RESULTS, labels: AF.RESULT_LABEL, any: 'Any result' },
                { type: 'select', key: 'runs', id: 'automations-jobs-runs', label: 'Runs', values: AF.RUNS, labels: AF.RUNS_LABEL, any: 'Anything' },
                { type: 'select', key: 'agent', id: 'automations-jobs-agent', label: 'Agent', values: AF.AGENTS, labels: AF.AGENT_LABEL, any: 'Any agent' },
            ],
            model: { EMPTY: AF.EMPTY, clean: AF.clean, chips: AF.chips, isFiltered: AF.isFiltered, without: AF.without },
        }, next => { setFilters('jobs', next); renderNav(true); });
    }
    const f = filtersOf('jobs'), rows = allJobs().filter(i => AF.matches(i, { ...f, state: '' }));
    const counts = AF.STATES.map(s => rows.filter(i => i.enabled === (s === 'active')).length);
    const create = document.createElement('button');
    create.type = 'button'; create.className = 'btn btn-primary'; create.textContent = 'New job'; create.setAttribute('data-on-click', 'job-new');
    const node = jobBar.draw({
        filters: f,
        pills: { label: 'Show jobs that are', current: f.state || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...AF.STATES.map((s, i) => ({ key: s, label: AF.STATE_LABEL[s], count: counts[i] }))],
            onPick: key => { setFilters('jobs', { ...filtersOf('jobs'), state: key === 'all' ? '' : key }); renderNav(true); } },
        action: create,
    });
    return { node, signature: JSON.stringify([f, counts, rows.length]) };
}

function jobsTable() {
    const rows = jobRows(), f = filtersOf('jobs');
    return { title: 'Jobs', noun: ['job', 'jobs'], rows,
        empty: { line: AF.isFiltered(f) || f.q ? 'No job matches the search and filters.' : 'No jobs yet.', hint: AF.isFiltered(f) || f.q ? '' : 'New job schedules one.' },
        signature: JSON.stringify(rows.map(i => [i.job, lastWords(i.run), nextOf(i.job), runsWords(i)])),
        node: () => DT.dataTable({
            label: `Jobs, ${rows.length}`, rows, layout: 'fixed', rowKey: i => i.id, rowName: i => i.name, state: stateOf('jobs'),
            open: i => { const t = $('group-table-view'); opener = { key: i.id, scroll: t ? t.scrollTop : 0 }; go(routeOf('jobs', i.id)); },
            columns: [
                { key: 'job', label: 'Job', primary: true, width: 'grow', line: 1, sort: true, sortValue: i => i.name, cell: i => DT.primaryButton(i.name), subtitle: runsWords },
                { key: 'schedule', label: 'Schedule', width: '12rem', line: 2, sort: true, sortValue: i => scheduleOf(i.job), cell: i => scheduleOf(i.job) },
                { key: 'last-run', label: 'Last run', width: '9rem', line: 2, tone: 'tertiary', sort: 'date', sortValue: i => i.run && i.run.started_at, cell: i => (i.run ? DT.chip(lastWords(i.run), resultClass(i.run)) : lastWords(null)) },
                { key: 'next', label: 'Next', width: '7rem', line: 1, tone: 'tertiary', sort: 'date', sortValue: i => (i.enabled ? i.job.next_fire_at : ''), cell: i => {
                    const cell = i.enabled ? DT.el('span', 'dt-time', nextOf(i.job)) : DT.chip('Paused');
                    if (i.enabled && i.job.next_fire_at) cell.title = `Next run ${atWords(i.job.next_fire_at)} your time`;
                    return cell;
                } },
            ],
        }).el };
}

registerGroupSource('automations', {
    signature: () => JSON.stringify([folder]),
    toolbar: key => (key === 'jobs' ? jobsToolbar() : null),
    keys: () => FOLDERS.map(f => f.key),
    redraw: () => renderNav(true),
    table: key => (key === 'jobs' ? jobsTable() : null),
    lead: () => ({ signature: JSON.stringify([folder, sections()]), node: () => VL.build({ id: 'automations-folders-page', label: 'Automations folders', sections: sections(), current: folder, onPick: pickFolder }) }), // a phone: the folders are one select on top of the table
    isEmpty: () => false, // the tab opens its folder itself (showAutomationsTab)
    showList: () => window.switchNavTab?.('automations'),
    empty: () => window.switchNavTab?.('automations'),
});

// ── Showing the tab, a folder or a job ───────────────────────────────────
function mount() {
    if (mounted) return;
    mounted = true;
    onJobsChanged(() => renderNav());
    readWorkflowNames();
}

/** Called by switchNavTab('automations'): the folders are drawn and the folder that was on screen opens, unless a job's page is the route (the route handler opens that). */
export function showAutomationsTab() {
    mount();
    renderNav(true);
    refreshJobs();
    if (document.body.getAttribute('data-nav-tab') !== 'automations') return; // the module arrived after the person had moved on
    const here = window.location.pathname;
    if (/^\/automations\/[a-z]+\/\d/.test(here)) return; // a job's page is the address: its route opens it
    $('scheduler-view')?.removeAttribute('data-phone-item');
    setFolder(folder);
    note(routeOf(folder));
    openGroupTable('automations', folder);
}

/** The route handler's call (app_routes.js): the folder, or the job, the address names. false when the job is not there. */
export async function openAutomationsRoute(r) {
    mount();
    renderNav(true);
    const key = folderOf(r.folder) ? r.folder : folder;
    if (r.id) {
        await refreshJobs();
        if (!jobList().some(j => Number(j.id) === r.id)) return false;
        setFolder(key);
        await selectScheduledJob(r.id);
        renderNav(true);
        return true;
    }
    refreshJobs();
    $('scheduler-view')?.removeAttribute('data-phone-item');
    setFolder(key);
    openGroupTable('automations', key);
    const row = opener && $('group-table-view')?.querySelector(`tr[data-key="${CSS.escape(String(opener.key))}"] .dt-primary`);
    if (row) { row.focus({ preventScroll: true }); $('group-table-view').scrollTop = opener.scroll; opener = null; }
    return true;
}

/** A job's page (or a deleted job's) goes back to its folder: one step back when the entry before is the folder, else the folder's address. */
export function backToFolder(key) {
    if (!opener && openJobId()) opener = { key: openJobId(), scroll: 0 }; // the job that was open gets the keyboard back, however it was opened
    const route = routeOf(folderOf(key) ? key : 'jobs');
    if (backIs(route)) history.back(); else go(route);
}

registerActions({
    'automations-search-filter': el => { setFilters(folder, { ...filtersOf(folder), q: String(el.value || '').trim() }); renderNav(true); }, // the sidebar's box and the page's share the one search
    'automations-back': el => backToFolder(textOf(el.dataset.folder)),
});
