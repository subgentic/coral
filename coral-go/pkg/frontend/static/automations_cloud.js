/* Automations through Coral Hub (#19571): the same folders and table components,
 * with metadata-only replies from #19570. This module has no mutation transport,
 * editor, agent launcher, or scheduler poll. A selection owns its requests; changing
 * computer/route aborts the old selection before drawing anything from the new one. */
import { state } from './state.js';
import { serverFetch, pathId } from './server_base.js';
import { go, currentRoute } from './nav.js';
import { showView } from './utils.js';
import { importOnce } from './import_once.js';
const { machineOnline, machineLabel } = await importOnce('./analytics_machine.js');
import { loadStyles } from './lazy_styles.js';
const DT = await importOnce('./data_table.js');
const VL = await importOnce('./view_list.js');
await loadStyles('automations_cloud.css');
const { el } = DT;
const OMITTED = 'Not shown through Coral Hub';
const FOLDERS = [ ['jobs', 'Jobs'], ['workflows', 'Workflows'], ['recent', 'Recent runs'], ['running', 'Running now'], ['failed', 'Failed'] ];
const names = new Map(FOLDERS);
let chosen = '', route = { view: 'automations', folder: 'jobs' }, generation = 0, controller = null, query = '';
const computers = () => [...new Map((state.servers || []).filter(s => s && s.id && s.id !== 'local').map(s => [s.id, s])).values()];
const word = x => x == null || x === '' ? '—' : String(x);
const dateOf = x => x ? new Date(x).toLocaleString() : '—';
const link = (text, onClick) => { const b = el('button', 'btn btn-small', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
const primary = (text, onClick) => { const b = DT.primaryButton(text); b.addEventListener('click', onClick); return b; };
const itemName = (r, kind) => String(r.name || r.display_name || r.workflow_name || r.job_name || `${kind === 'workflow' ? 'Workflow' : 'Job'} run ${r.id}`);
function nav() {
    const spec = { sections: [{ title: 'Automations', items: FOLDERS.map(([key, label]) => ({ key, label })) }], current: route.folder, onPick: folder => go({ view: 'automations', folder }) };
    const side = document.getElementById('automations-nav-list');
    if (side) side.replaceChildren(VL.build({ id: 'cloud-automation-folders', label: 'Automations folders', ...spec }));
    return VL.build({ id: 'cloud-automation-page-folders', label: 'Automations views', tabs: true, ...spec });
}
function shell() {
    showView('scheduler-view');
    document.getElementById('workflows-view')?.removeAttribute('data-phone-item');
    const host = document.getElementById('scheduler-detail');
    host.classList.add('cloud-automations');
    const heading = document.getElementById('sched-view-header');
    heading.replaceChildren(el('h2', '', 'Automations'));
    const label = el('label', 'cloud-automation-picker', 'Computer '), picker = el('select', 'field');
    picker.id = 'cloud-automation-computer';
    for (const s of computers()) { const option = el('option', '', machineLabel(s.id) + (machineOnline(s.id) ? '' : ' (offline)')); option.value = s.id; picker.append(option); }
    picker.value = chosen; label.append(picker);
    picker.addEventListener('change', () => { chosen = picker.value; openAutomationsRoute({ view: 'automations', folder: route.folder }); });
    heading.append(label);
    const panel = el('div', 'cloud-automation-content'); panel.setAttribute('aria-busy', 'true');
    host.replaceChildren(nav(), el('p', 'goals-note', 'Read only. Manage automations in this computer’s Coral.'), panel);
    return panel;
}
async function read(server, path, signal) {
    if (!machineOnline(server)) throw new Error(`${machineLabel(server)} is offline, so its automations can't be read now.`);
    const response = await serverFetch(server, path, { signal });
    // Read error bodies too: failed reads must not leave streams in the pool.
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${machineLabel(server)} can't show automations here. It may need a newer Coral.`);
    if (!data || typeof data !== 'object') throw new Error('Could not read automations.');
    return data;
}
function facts(rows) {
    const dl = el('dl', 'facts cloud-automation-facts');
    for (const [name, value] of rows) dl.append(el('dt', '', name), el('dd', '', word(value)));
    return dl;
}
function runFacts(run) {
    return facts([['Status', run.status], ['Started', dateOf(run.started_at || run.scheduled_at)], ['Finished', dateOf(run.finished_at)], ['Duration', run.duration_seconds == null ? '—' : `${Number(run.duration_seconds)} s`], ['Error code', run.error_code], ['Failed step', run.failed_step?.number], ['Output and error details', OMITTED], ['Files and working folder', OMITTED]]);
}
function runTable(rows, kind, openRun) {
    return DT.dataTable({ label: 'Runs', fold: 'labeled', rows, rowKey: r => `${r.kind || kind}-${r.id}`, rowName: r => itemName(r, kind), open: openRun,
        columns: [
            { key: 'name', label: 'Run', primary: true, width: 'grow', cell: r => { const b = primary(`Run ${word(r.id)} · ${itemName(r, r.kind || kind)}`, () => openRun(r)); b.dataset.cloudRun = ''; return b; } },
            { key: 'status', label: 'Status', width: '8rem', cell: r => word(r.status) },
            { key: 'started', label: 'Started', width: '14rem', cell: r => dateOf(r.started_at || r.scheduled_at), dropAt: 28 },
        ], empty: 'No runs yet.' }).el;
}
async function details(panel, server, request, signal, myGeneration) {
    const kind = request.folder === 'workflows' ? 'workflow' : 'job';
    const base = kind === 'workflow' ? '/api/workflows' : '/api/scheduled/jobs';
    const id = pathId(request.id);
    const item = await read(server, `${base}/${id}`, signal);
    if (myGeneration !== generation) return;
    panel.append(link(`Back to ${names.get(request.folder)}`, () => go({ view: 'automations', folder: request.folder })), el('h3', '', itemName(item, kind)));
    if (request.run && kind === 'workflow') {
        const run = await read(server, `/api/workflows/runs/${pathId(request.run)}`, signal);
        if (myGeneration !== generation) return;
        panel.append(el('h3', '', `Run ${word(run.id)}`), runFacts(run));
        return;
    }
    panel.append(facts(kind === 'job' ? [['Schedule', item.cron_expr], ['Time zone', item.timezone], ['State', item.paused ? 'Paused' : item.enabled ? 'On' : 'Off'], ['Next run', dateOf(item.next_fire_at)], ['Prompt, flags, folder and description', OMITTED]] : [['Steps', item.step_count], ['State', item.enabled ? 'On' : 'Off'], ['Step prompts, commands and files', OMITTED], ['Folder and description', OMITTED]]));
    panel.append(el('h3', '', 'Runs'));
    const runsHost = el('div'); panel.append(runsHost);
    let offset = 0, loading = false;
    const more = link('Load more runs', loadRuns);
    async function loadRuns() {
        if (loading || signal.aborted) return;
        loading = true; more.disabled = true;
        try {
            const data = await read(server, `${base}/${id}/runs?limit=20&offset=${offset}`, signal);
            if (myGeneration !== generation) return;
            const rows = Array.isArray(data.runs) ? data.runs : [];
            offset += rows.length;
            runsHost.append(runTable(rows, kind, r => {
                if (kind === 'workflow') go({ view: 'automations', folder: 'workflows', id, run: pathId(r.id) });
                else { runsHost.replaceChildren(link('Back to runs', () => openAutomationsRoute(request)), el('h3', '', `Run ${word(r.id)}`), runFacts(r)); more.hidden = true; }
            }));
            more.hidden = !rows.length || !(data.has_more || Number(data.total) > offset);
        } catch (e) { if (!signal.aborted && myGeneration === generation) runsHost.append(el('p', 'notice notice-error', e.message)); }
        finally { loading = false; more.disabled = false; }
    }
    await loadRuns(); panel.append(more);
}
export async function openAutomationsRoute(request = {}) {
    route = { ...request, view: 'automations', folder: names.has(request.folder) ? request.folder : 'jobs' };
    controller?.abort(); controller = new AbortController();
    const { signal } = controller, myGeneration = ++generation;
    const list = computers(); if (!list.some(s => s.id === chosen)) chosen = list[0]?.id || '';
    const server = chosen, panel = shell();
    if (!server) { panel.replaceChildren(el('p', 'empty-state-line', 'Link a computer to see automations.')); panel.removeAttribute('aria-busy'); return true; }
    panel.append(el('p', 'goals-note', 'Loading automations…'));
    try {
        if (route.id && ['jobs', 'workflows'].includes(route.folder)) {
            panel.replaceChildren(); await details(panel, server, { ...route }, signal, myGeneration);
        } else {
            const folder = route.folder;
            const path = folder === 'jobs' ? '/api/scheduled/jobs' : folder === 'workflows' ? '/api/workflows' : `/api/automations/runs?limit=50${folder === 'running' ? '&result=running' : folder === 'failed' ? '&result=failed' : ''}`;
            const data = await read(server, path, signal);
            if (myGeneration !== generation) return true;
            panel.replaceChildren(el('h3', '', names.get(folder)));
            if (['jobs', 'workflows'].includes(folder)) {
                const rows = (data[folder] || []).filter(r => !query || String(r.name || '').toLowerCase().includes(query));
                const open = r => go({ view: 'automations', folder, id: pathId(r.id) });
                panel.append(DT.dataTable({ label: names.get(folder), fold: 'labeled', rows, rowKey: r => r.id, rowName: r => String(r.name || ''), open,
                    columns: [
                        { key: 'name', label: folder === 'jobs' ? 'Job' : 'Workflow', primary: true, width: 'grow', cell: r => primary(String(r.name || ''), () => open(r)) },
                        { key: 'state', label: 'State', width: '7rem', cell: r => r.paused ? 'Paused' : r.enabled ? 'On' : 'Off' },
                        { key: 'last', label: 'Last run', width: '9rem', cell: r => word(r.last_run?.status) },
                    ], empty: 'No automations found.' }).el);
            } else {
                const rows = (data.runs || []).filter(r => !query || itemName(r, r.kind).toLowerCase().includes(query));
                panel.append(runTable(rows, '', async r => {
                    const run = r.kind === 'workflow' ? await read(server, `/api/workflows/runs/${pathId(r.id)}`, signal).catch(() => null) : r;
                    if (run && myGeneration === generation) panel.replaceChildren(link('Back to runs', () => openAutomationsRoute({ view: 'automations', folder })), el('h3', '', `Run ${word(run.id)}`), runFacts(run));
                }));
                if (data.has_more) panel.append(el('p', 'goals-note', 'Showing the latest 50 runs. Open a job or workflow for its earlier runs.'));
            }
        }
    } catch (e) {
        if (!signal.aborted && myGeneration === generation) panel.replaceChildren(el('p', 'notice notice-error', e.message), link('Retry', () => openAutomationsRoute(route)));
    } finally { if (myGeneration === generation) panel.removeAttribute('aria-busy'); }
    return true;
}
export function showAutomationsTab() { return openAutomationsRoute(currentRoute()?.view === 'automations' ? currentRoute() : route); }
export function filterAutomations(value) { query = String(value || '').trim().toLowerCase(); return openAutomationsRoute(route); }
export function backToFolder(folder) { go({ view: 'automations', folder }); }
