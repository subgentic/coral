/* The team page's Workers (mock v3 idea 2, #21467): the setups the Operator approved for the team, from which the Orchestrator starts a worker for a task ('coral-board worker launch "NAME" --task N').
 * "Add a worker" is New agent's own steps (launch_dialog.js showAddAgentFlow with a worker): the last step saves the worker to the team instead of starting it. The row's menu has Edit, Launch one now and
 * Remove from this team. Coral writes the list into the Orchestrator's instructions and keeps it current; nothing here tells it. The server holds the list (GET /api/board/<team>/workers); everything drawn is built
 * with the DOM and textContent. Lazy: the Agents tab and the launch dialog import it. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { boardFetch, keyLabel } from './server_base.js';
await loadStyles('team_workers.css');
const { el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce
const DT = await importOnce('./data_table.js');
const { launch } = await importOnce('./launch_state.js');
const tableState = DT.tableState();

const S = { team: '', workers: [], launched: {}, max: 12, loaded: false, failed: false };
let root = null;
let menuSeq = 0;


const say = (t) => { const s = root && root.querySelector('.workers-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const toast = async (text, bad = false) => (await importOnce('./utils.js')).showToast(text, bad);
const post = (path, method, body) => boardFetch(S.team, path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const errorOf = async (r, fallback) => { const d = await r.json().catch(() => ({})); return d.error || d.message || fallback; };

async function load() {
    try {
        const r = await boardFetch(S.team, '/workers');
        if (!r.ok) { S.failed = true; return; }
        const d = await r.json();
        S.workers = Array.isArray(d.workers) ? d.workers : []; S.launched = d.launched && typeof d.launched === 'object' ? d.launched : {}; S.max = Number(d.max) || 12; S.failed = false;
    } catch { S.failed = true; }
    S.loaded = true;
}

const iconMore = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>';

function rowMenu(w) {
    const id = `worker-menu-${++menuSeq}`, wrap = el('span', 'workers-more');
    const toggle = el('button', 'btn btn-quiet btn-icon workers-more-toggle'); toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', id); toggle.setAttribute('aria-label', `More actions for ${w.name}`);
    toggle.innerHTML = iconMore;
    const menu = el('div', 'menu workers-menu'); menu.id = id; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${w.name}`);
    const item = (label, run, cls) => { const b = el('button', `menu-item${cls ? ' ' + cls : ''}`, label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.addEventListener('click', e => { e.stopPropagation(); importOnce('./menu_button.js').then(m => m.closeMenus({ restoreFocus: true })); run(); }); menu.append(b); };
    item('Edit', () => openEditor(w));
    item('Launch one now', () => launchNow(w));
    item('Remove from this team', () => removeWorker(w), 'menu-item-danger');
    toggle.addEventListener('click', async e => { e.stopPropagation(); (await importOnce('./menu_button.js')).toggleMenu(toggle); });
    wrap.append(toggle, menu);
    return wrap;
}

const startCost = (w) => { const c = el('span', w.cached ? 'workers-cost workers-cost-cached' : 'workers-cost workers-cost-none'); if (w.cached) { c.append(el('span', 'workers-tick', '✓'), ' Cached start'); } else c.textContent = 'Not cached'; return c; };

const subLine = (w) => `${w.role || 'No persona'} \u00b7 ${w.purpose || 'no purpose said'}`;
const costWord = (w) => (w.cached ? 'Cached start' : 'Not cached');

function table() {
    const menuItems = (w) => [{ label: 'Edit', run: () => openEditor(w) }, { label: 'Launch one now', run: () => launchNow(w) }, { label: 'Remove from this team', run: () => removeWorker(w) }];
    return DT.dataTable({
        label: `Workers, ${S.workers.length}`, rows: S.workers, rowKey: w => w.name, state: tableState,
        open: (w) => openEditor(w),
        columns: [
            { key: 'name', label: 'Worker', primary: true, width: 'grow', line: 1, cell: w => { const b = DT.primaryButton('', ''); b.append(el('b', 'workers-name', w.name), el('small', 'workers-sub', subLine(w))); b.setAttribute('aria-label', `Edit ${w.name}`); return b; } },
            { key: 'runs', label: 'Runs as', width: '8rem', line: 2, dropAt: 36, cell: w => w.runs_as || w.agent_type },
            { key: 'cost', label: 'Start-up cost', width: '10rem', line: 2, dropAt: 36, cell: w => startCost(w) },
            { key: 'actions', label: 'Actions', hideLabel: true, width: '3rem', line: 2, cell: w => rowMenu(w) },
        ], oneLine: false, resize: false, sortBar: false,
        mail: w => ({ lead: { text: w.name, name: w.name }, title: w.name, snippet: `${subLine(w)} \u00b7 ${w.runs_as || w.agent_type}`, state: costWord(w), time: '', actions: menuItems(w).map(a => ({ label: a.label, run: a.run })) }),
    }).el;
}

function draw() {
    if (!root) return;
    root.replaceChildren();
    if (S.failed || !S.loaded) { root.hidden = true; return; } // a team this computer cannot read (a Hub's, an older Coral): no section
    root.hidden = false;
    const panel = el('section', 'pane workers-panel'); panel.setAttribute('aria-labelledby', 'workers-title');
    const head = el('div', 'workers-head');
    const title = el('h3', 'workers-title', 'Workers the orchestrator can launch'); title.id = 'workers-title';
    const count = el('span', 'workers-count', String(S.workers.length)); count.setAttribute('aria-label', `${S.workers.length} workers`);
    const add = el('button', 'btn workers-add', 'Add a worker'); add.type = 'button'; add.disabled = S.workers.length >= S.max;
    if (add.disabled) add.title = `A team has at most ${S.max} approved workers`;
    add.addEventListener('click', () => openEditor(null));
    head.append(title, count, el('span', 'workers-spacer'), add);
    const status = el('div', 'workers-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    panel.append(head, status);
    if (S.workers.length) panel.append(table());
    else panel.append(el('p', 'empty-state empty-state-tight', 'No approved workers yet. Until you add some, the orchestrator makes up each worker’s CLI, model and instructions itself.'));
    panel.append(el('p', 'workers-cap', '“Add a worker” opens the New agent steps you know; the last step saves it to this team instead of starting it. The row menu holds Edit, Launch one now and Remove from this team. “Cached start” means the provider can reuse this worker’s opening instructions between launches; how much that saves needs measuring.'));
    root.append(panel);
}

/** Show the team's workers in `host` (the Agents tab calls it on every draw). */
export async function mountWorkers(host, team) {
    if (team !== S.team) Object.assign(S, { team, workers: [], launched: {}, loaded: false, failed: false });
    root = host; root.classList.add('workers-host');
    draw();
    await load();
    draw();
    if (page) chipUp(page);
}

let page = null, watcher = null;
const chipOf = (w) => { const c = el('span', 'team-agent-from', `From "${w}"`); c.dataset.from = w; return c; };
/** Put the From chip on each agent a worker started: on its row of the Agents table, and on its own page under the heading. */
function chipUp(pg) {
    for (const tr of pg.querySelectorAll('tr[data-key]')) {
        const w = S.launched[tr.dataset.key], cell = tr.querySelector('.team-agent-name');
        if (w && cell && !cell.querySelector('.team-agent-from')) cell.append(chipOf(w));
    }
    const line = pg.querySelector('.goals-detail-line'), heading = pg.querySelector('.goals-detail-line')?.previousElementSibling;
    const w = line && heading && S.launched[(heading.textContent || '').trim()];
    if (w && !line.querySelector('.team-agent-from')) line.append(chipOf(w));
}

/** The Agents tab calls it on every showing: the workers go in their own section under the table, and the chips follow every redraw of the rows and the agent's page. */
export function attachWorkers(pg, team) {
    page = pg;
    let host = pg.querySelector('.team-workers');
    if (!host) { host = el('div', 'team-workers'); pg.append(host); }
    if (watcher) watcher.disconnect();
    watcher = new MutationObserver(() => chipUp(pg));
    watcher.observe(pg, { childList: true, subtree: true });
    return mountWorkers(host, team);
}

async function reload() { await load(); draw(); }

async function openEditor(worker) {
    // The page's own Add agent (window.showAddAgentToBoard builds the dialog's markup on first use); its Add agent flow is then dressed as a worker's.
    if (typeof window.showAddAgentToBoard !== 'function') return;
    await window.showAddAgentToBoard(S.team, '');
    for (let i = 0; i < 50 && !(launch.addTo && launch.addTo.board); i++) await new Promise(r => setTimeout(r, 100)); // the team's folder is read first
    if (!launch.addTo) return; // the dialog did not open (a computer that is away, a CLI that is missing): nothing to dress
    launch.addTo.worker = { team: S.team, existing: worker, onSaved: reload };
    await dressWorkerDialog(launch.addTo.worker);
}

async function launchNow(w) {
    say(`Starting ${w.name}…`);
    try {
        const r = await post(`/workers/${encodeURIComponent(w.name)}/launch`, 'POST', {});
        if (!r.ok) { await toast(await errorOf(r, `Could not start ${w.name}`), true); return; }
        const d = await r.json().catch(() => ({}));
        await toast(`Launched ${d.display_name || w.name}`);
        await reload();
    } catch { await toast(`Could not start ${w.name}`, true); }
}

async function removeWorker(w) {
    const { showConfirmModal } = await importOnce('./confirm_dialog.js');
    showConfirmModal('Remove from this team', `Take ${w.name} off ${keyLabel(S.team)}’s approved workers? The orchestrator is told the list changed. Agents already started from it keep running.`, async () => {
        try {
            const r = await post(`/workers/${encodeURIComponent(w.name)}`, 'DELETE');
            if (!r.ok) { await toast(await errorOf(r, `Could not remove ${w.name}`), true); return; }
            await toast(`${w.name} was removed from the team's workers`);
            await reload();
        } catch { await toast(`Could not remove ${w.name}`, true); }
    }, null, { label: 'Remove worker', danger: true });
}

// ── the dialog: New agent's steps, saved to the team ─────────────────────

/** The values New agent's form starts from when a worker is edited. */
export function formValue(w) { return { name: '', prompt: w.instructions || '', agentType: w.agent_type, model: w.model || '', thinking: w.thinking || undefined }; }

/** Word the dialog for a worker: its title, the name field, the purpose line and the button that saves. `ctx`: { team, existing, onSaved }. */
export async function dressWorkerDialog(ctx) {
    const modal = document.getElementById('launch-modal'); if (!modal) return;
    document.addEventListener('launch-modal-hidden', undressWorkerDialog, { once: true });
    modal.setAttribute('data-worker', ctx.existing ? 'edit' : 'add');
    const title = document.getElementById('launch-agent-title-text'); if (title) title.textContent = ctx.existing ? 'Edit worker' : `Add a worker to ${keyLabel(ctx.team)}`;
    const lab = document.querySelector('label[for="launch-agent-name-input"]'); if (lab) lab.textContent = 'Worker name'; // the name the orchestrator launches it by; Save worker asks for it
    const name = document.getElementById('launch-agent-name-input'); if (name && ctx.existing) name.value = ctx.existing.name;
    if (!document.getElementById('launch-worker-purpose')) {
        const host = el('div', 'launch-worker-purpose-host'); document.getElementById('agent-name-host')?.after(host);
        const { mountSettingsView } = await importOnce('./settings_view.js');
        mountSettingsView(host, { mode: 'form', fields: [{ key: 'purpose', type: 'text', id: 'launch-worker-purpose', label: 'What it is for', placeholder: 'e.g. code tasks, reviews, small fixes', help: 'One line the orchestrator reads beside the name.', optional: true, messageAsIs: true }] });
    }
    const purpose = document.getElementById('launch-worker-purpose'); if (purpose) purpose.value = ctx.existing ? ctx.existing.purpose || '' : '';
    if (ctx.existing) { const { setAgentConfig } = await importOnce('./agent_config_form.js'); setAgentConfig('launch-agent-acf', formValue(ctx.existing)); }
    const go = document.getElementById('launch-agent-go');
    if (go) {
        go.textContent = 'Save worker';
        if (!go.dataset.workerGuard) { // the dialog's Launch starts an agent; while a worker is open the same button saves it (the guard runs first and says nothing otherwise)
            go.dataset.workerGuard = '1';
            go.addEventListener('click', e => { if (launch.addTo && launch.addTo.worker) { e.stopImmediatePropagation(); e.preventDefault(); saveWorkerFromDialog(); } }, true);
        }
    }
}

/** Undo what dressWorkerDialog changed: a New agent dialog opened next is a plain one. */
export function undressWorkerDialog() {
    document.getElementById('launch-modal')?.removeAttribute('data-worker');
    document.querySelector('.launch-worker-purpose-host')?.remove();
    const go = document.getElementById('launch-agent-go'); if (go) go.textContent = 'Launch';
}

/** The dialog's last step: save the worker to the team (POST, or PUT for an edit) and close the dialog. */
export async function saveWorkerFromDialog() {
    const ctx = launch.addTo && launch.addTo.worker; if (!ctx) return;
    const { getAgentConfig } = await importOnce('./agent_config_form.js');
    const cfg = getAgentConfig('launch-agent-acf');
    const nameEl = document.getElementById('launch-agent-name-input'), name = (nameEl?.value || '').trim();
    if (!name) { nameEl?.focus(); await toast('A worker needs a name', true); return; }
    const persona = document.getElementById('launch-persona-select')?.value || '';
    const perm = cfg.permissionMode === 'default' ? 'default' : String(cfg.permissionMode || '').startsWith('custom:') ? cfg.permissionMode : '';
    const skills = (await importOnce('./launch_skills.js').catch(() => null))?.launchSkillIds('launch-skills') || [];
    const body = {
        name, role: persona && persona !== '__custom__' ? persona : '', purpose: (document.getElementById('launch-worker-purpose')?.value || '').trim(),
        agent_type: cfg.agentType || 'claude', model: cfg.model || '', thinking: cfg.thinking || '', instructions: cfg.prompt || '',
        working_dir: launch.addTo.workDir || '', skills, permission_mode: perm,
    };
    const go = document.getElementById('launch-agent-go'); if (go) { go.disabled = true; go.textContent = 'Saving…'; }
    try {
        S.team = ctx.team;
        const r = ctx.existing ? await post(`/workers/${encodeURIComponent(ctx.existing.name)}`, 'PUT', body) : await post('/workers', 'POST', body);
        if (!r.ok) { await toast(await errorOf(r, 'Could not save the worker'), true); return; }
        const { hideLaunchModal } = await importOnce('./launch_core.js');
        hideLaunchModal();
        await toast(`${ctx.existing ? 'Saved' : 'Added'} worker ${name}`);
        if (ctx.onSaved) await ctx.onSaved();
    } catch { await toast('Could not save the worker', true); }
    finally { if (go) { go.disabled = false; go.textContent = launch.addTo && launch.addTo.worker ? 'Save worker' : 'Launch'; } } // a dialog that closed is a plain one again
}
