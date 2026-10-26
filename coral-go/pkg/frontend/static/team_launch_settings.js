/* The team launch dialog's step 3 tabs Workflow, Health check and Messaging (#7407). They are the board's settings, and the board does not exist until the launch answers: the working mode, its guidance and
 * the health check being on go in the launch request (it takes working_mode and health_monitor); the rest (Require a goal, the health check's numbers and rules, the two messaging switches) are held here and
 * applied with one PUT /api/board/<id>/settings, the route Team settings uses, once the launch has made the board. */
import { importOnce } from './import_once.js';
import { switchRow } from './switch_row.js';
import { escapeHtml } from './utils.js';
import { boardFetch } from './server_base.js';
const { healthPanelHTML, readHealth, healthProblem, wireHealthForm, HEALTH_DEFAULTS } = await importOnce('./team_health_settings.js');
const { requireGoalSentence } = await importOnce('./task_goals.js');
const { initSectionDialog } = await importOnce('./section_dialog.js');

const ASKS_ARE_TASKS_HINT = 'When an agent needs another agent to do something, it creates a task. Plain posts are for questions and status.';
const WORKFLOW_HINT = 'Guidance the agents get on how to share the folder. It does not create worktrees.';

function workflowHTML() {
    return `<label class="team-wf-field" for="team-wm-mode"><span class="launch-field-head">Working mode</span></label>
        <select id="team-wm-mode" name="mode" aria-describedby="team-wm-hint"><option value="none">None</option><option value="shared_checkout">Shared checkout</option><option value="worktrees">Worktrees</option></select>
        <p class="settings-hint" id="team-wm-hint">${escapeHtml(WORKFLOW_HINT)}</p>
        ${switchRow({ label: 'Include dependent-queue guidance', name: 'dependency_guidance', attrs: ' id="team-wm-dep"', labelClass: 'check-hit' })}
        ${switchRow({ label: 'Requests for work are tasks', name: 'asks_are_tasks', checked: true, attrs: ' id="team-wm-asks"', labelClass: 'check-hit', describedBy: ['team-wm-asks-hint'] })}
        <p class="settings-hint" id="team-wm-asks-hint">${escapeHtml(ASKS_ARE_TASKS_HINT)}</p>
        ${switchRow({ label: 'Require a goal', name: 'require_goal', attrs: ' id="team-wm-goal"', labelClass: 'check-hit', describedBy: ['team-wm-goal-hint'] })}
        <p class="settings-hint" id="team-wm-goal-hint">${escapeHtml(requireGoalSentence)}</p>`;
}

function messagingHTML() {
    return `${switchRow({ label: 'Message teams on other computers', name: 'cross_team_messaging', attrs: ' id="team-xt-msg"', labelClass: 'check-hit', describedBy: ['team-xt-hint'] })}
        <p class="settings-hint" id="team-xt-hint">Through Coral Hub links.</p>
        ${switchRow({ label: 'Share files with teams on other computers', name: 'cross_team_artifacts', attrs: ' id="team-xt-files"', labelClass: 'check-hit', describedBy: ['team-xt-files-hint'] })}
        <p class="settings-hint" id="team-xt-files-hint">Another team can message this team only when its Coral Hub account has linked the two teams and cross-team messaging is on here.</p>`;
}

// The section list (section_dialog.js) gives each pane its own id: they are found by their section.
const pane = name => document.querySelector(`#team-settings-panes [data-section="${name}"]`);
const healthForm = () => pane('health')?.querySelector('form');

// A closed dialog holds no health form: other dialogs' scripts and tests look for a form by its class, and a hidden copy would be found first.
document.addEventListener('launch-modal-hidden', () => { for (const name of ['workflow', 'health', 'messaging']) { const p = pane(name); if (p) p.replaceChildren(); } });

/** Draw the three tabs with their defaults (every time the team dialog opens: nothing from the last team stays) and build the section list once. */
export function mountTeamLaunchSettings() {
    const wf = pane('workflow'), hc = pane('health'), ms = pane('messaging');
    if (!wf || !hc || !ms) return;
    wf.innerHTML = workflowHTML();
    hc.innerHTML = healthPanelHTML(HEALTH_DEFAULTS, []);
    hc.querySelector('.health-actions')?.remove(); // the dialog's Launch team saves it: no Save and Reset of its own
    // Who gets the check is the Orchestrator at launch (a list of one is noise): the select stays, hidden, with its default, and the switch's line says where it goes. Another recipient is in Team settings once the team exists.
    const rcpt = hc.querySelector('select[name="recipient"]');
    if (rcpt) { rcpt.value = ''; const label = rcpt.closest('label'); if (label) label.hidden = true; }
    const why = hc.querySelector('#hc-on-h'); if (why) why.textContent = 'Checks in on the team every few minutes. Sent to the Orchestrator. Uses tokens each time.';
    // No (i) icons here: each switch's line is on the page (the Workflow tab's pattern), and the rows that only matter while the check is on are hidden until it is.
    hc.querySelectorAll('.settings-info-btn').forEach(b => b.remove());
    hc.querySelector('#hc-on-w')?.remove();
    const clearHint = hc.querySelector('#hc-clear-w'); if (clearHint) { clearHint.hidden = false; clearHint.className = 'settings-hint'; hc.querySelector('[data-check-dep]')?.after(clearHint); }
    const hform = hc.querySelector('form');
    hform.classList.remove('working-mode-form'); hform.classList.add('team-launch-health'); // not the Team settings dialog's form: that name is looked up page-wide
    hform.addEventListener('submit', e => e.preventDefault()); // there is no Save here: Launch team saves it
    wireHealthForm(hform);
    const dependents = [...hform.querySelectorAll('.health-row, [data-check-dep]'), clearHint].filter(Boolean);
    const syncDependents = () => { const on = hform.querySelector('[name="on"]').checked; for (const e of dependents) e.hidden = !on; };
    hform.querySelector('[name="on"]').addEventListener('change', syncDependents);
    syncDependents();
    ms.innerHTML = messagingHTML();
    for (const id of ['team-goal', 'team-custom-instructions']) { const el = document.getElementById(id); if (el) el.value = ''; }
    const shell = document.querySelector('#launch-step-team .settings-shell');
    if (shell && !shell.dataset.sdBuilt) { initSectionDialog(shell); shell.dataset.sdBuilt = '1'; }
}

/**
 * What the three tabs and the Start tab say: { working_mode, health_monitor, board, problem }. `working_mode` and `health_monitor` go in the launch request; `board` (null when nothing differs from a new team's own
 * settings) is the PUT after it. `problem` is { pane, el, text } for a health number out of its range, to open that tab and say so.
 */
export function readTeamLaunchSettings() {
    const root = document.getElementById('team-settings-panes');
    const val = n => root.querySelector(`[name="${n}"]`);
    const wm = { mode: val('mode')?.value || 'none', dependency_guidance: !!val('dependency_guidance')?.checked, asks_are_tasks: !!val('asks_are_tasks')?.checked, custom_instructions: (document.getElementById('team-custom-instructions')?.value || '').trim() };
    const out = { working_mode: null, health_monitor: undefined, board: null, problem: null };
    if (wm.mode !== 'none' || wm.dependency_guidance || wm.asks_are_tasks || wm.custom_instructions) out.working_mode = wm; // a new team has Requests for work are tasks on: it is sent unless the person turned it off
    const board = {};
    if (val('require_goal')?.checked) board.require_goal = true;
    const form = healthForm();
    if (form) {
        const problem = healthProblem(form);
        if (problem) out.problem = { pane: 'health', ...problem };
        else {
            const h = readHealth(form, HEALTH_DEFAULTS);
            if (h.on) out.health_monitor = true;
            if (JSON.stringify(h) !== JSON.stringify(HEALTH_DEFAULTS)) board.health = h;
        }
    }
    if (val('cross_team_messaging')?.checked) board.cross_team_messaging = true;
    if (val('cross_team_artifacts')?.checked) board.cross_team_artifacts = true;
    if (Object.keys(board).length) out.board = board;
    return out;
}

/** Apply the held board settings to the launched team. Returns '' when it worked (or there was nothing), else a sentence for the toast. */
export async function applyTeamBoardSettings(teamKey, board) {
    if (!board) return '';
    try {
        const resp = await boardFetch(teamKey, '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', ...board }) });
        if (resp.ok) return '';
        const names = { require_goal: 'Require a goal', health: 'the health check', cross_team_messaging: 'messaging', cross_team_artifacts: 'file sharing' };
        return `The team started, but these settings were not saved: ${Object.keys(board).map(k => names[k] || k).join(', ')}. Set them in Team settings.`;
    } catch {
        return 'The team started, but its settings were not saved. Set them in Team settings.';
    }
}
