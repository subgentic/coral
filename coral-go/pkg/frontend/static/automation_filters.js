import { serverFilter } from './inbox_servers.js';
/* The Automations folders' search, pills and Filters (Goal #74; UI/UX #8862 section 2): what they are, how they are kept in the browser per folder and how an item is matched against them. Pure (no DOM; it
 * imports the model and the browser store) so it is tested on its own; automations.js draws the controls on the shared list bar (inbox_toolbar.js) and asks the rows. A folder's rows are items: a job or a
 * workflow as one flat object (jobItem below), so Jobs, Workflows, Running now and Failed are matched by the same code and every field is one the server already sends. */
import { defineFilters, text } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

export const STATES = ['active', 'paused'];
export const STATE_LABEL = { active: 'Active', paused: 'Paused' };
export const RESULTS = ['passed', 'failed', 'running', 'never'];
export const RESULT_LABEL = { passed: 'Passed', failed: 'Failed', running: 'Running', never: 'Never run' };
export const RUNS = ['workflow', 'prompt'];
export const RUNS_LABEL = { workflow: 'A workflow', prompt: 'An agent prompt' };
export const AGENTS = ['claude', 'agy', 'codex', 'pi'];
export const AGENT_LABEL = { claude: 'Claude', agy: 'Antigravity', codex: 'Codex', pi: 'Pi' };
export const SORTS = ['next', 'name', 'last'];
export const SORT_LABEL = { next: 'Next run', name: 'Name', last: 'Last run' };

const model = defineFilters({
    server: serverFilter,
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    state: { type: 'choice', values: STATES }, // the pills of the toolbar: a shortcut of this field, so it has no chip of its own
    result: { type: 'choice', values: RESULTS, chip: v => `Result: ${RESULT_LABEL[v]}` },
    runs: { type: 'choice', values: RUNS, chip: v => `Runs: ${RUNS_LABEL[v]}` },
    agent: { type: 'choice', values: AGENTS, chip: v => `Agent: ${AGENT_LABEL[v]}` },
    sort: { type: 'order', values: SORTS, default: 'next' },
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

const kept = model.persist(folder => `coral-automations-${folder}-filters`);
/** The filters kept in this browser for a folder, or the empty ones. */
export const loadFilters = folder => ({ ...kept.load(folder, browserLocal), q: '' });
export const saveFilters = (folder, f) => kept.save(folder, { ...f, q: '' }, browserLocal); // the search words are not kept: a page opened later starts with an empty box

/** What a run's status is in the four words the Result filter has. A run that was cut short by a restart, or that is only waiting to start, is none of them: it does not match a Result. */
export function resultOf(run) {
    if (!run) return 'never';
    if (run.status === 'running') return 'running';
    if (run.status === 'failed' || run.status === 'killed') return 'failed';
    if (run.status === 'completed' && run.exit_reason !== 'ended_while_coral_was_down') return 'passed';
    return '';
}

/** A job as one item of a folder. `workflowName(id)` is the name of the workflow it runs ('' when not known). */
export function jobItem(job, workflowName = () => '') {
    const workflow = !!job.workflow_id;
    return { kind: 'job', id: Number(job.id), name: String(job.name || ''), enabled: !!job.enabled, run: job.last_run || null, result: resultOf(job.last_run),
        runs: workflow ? 'workflow' : 'prompt', agent: workflow ? '' : String(job.agent_type || 'claude'), does: workflow ? workflowName(job.workflow_id) : String(job.prompt || ''),
        at: Date.parse(job.next_fire_at || '') || 0, last: Date.parse((job.last_run && (job.last_run.started_at || job.last_run.finished_at)) || '') || 0, job };
}

/** Whether an item passes the filters (the pill's state is a filter here too). The search covers the name and what the item runs. */
export function matches(item, f) {
    const c = clean(f);
    if (c.q && ![item.name, item.does].join(' ').toLowerCase().includes(c.q.toLowerCase())) return false;
    if (c.state && (c.state === 'active') !== item.enabled) return false;
    if (c.result && item.result !== c.result) return false;
    if (c.runs && item.runs !== c.runs) return false;
    if (c.agent && item.agent !== c.agent) return false;
    return true;
}

/** The items in the order the filters ask for (a new array): by next run (a paused or unscheduled one last), by name, or by last run, newest first. */
export function ordered(items, f) {
    const c = clean(f), list = [...items];
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (c.sort === 'name') return list.sort(byName);
    if (c.sort === 'last') return list.sort((a, b) => b.last - a.last || byName(a, b));
    return list.sort((a, b) => (a.enabled && a.at ? a.at : Infinity) - (b.enabled && b.at ? b.at : Infinity) || byName(a, b));
}

/** The text of a text field, for the callers that read one raw (the search box). */
export const words = v => text(v, 200);
