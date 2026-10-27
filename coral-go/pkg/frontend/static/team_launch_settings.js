/* The team launch dialog's step 3: Start, Workflow, Health check and Messaging as one settings_view (#8455; the tabs were #7407). They are the board's settings, and the board does not exist until the launch answers: the working mode, its guidance and
 * the health check being on go in the launch request (it takes working_mode and health_monitor); the rest (Require a goal, the health check's numbers and rules, the two messaging switches) are held here and
 * applied with one PUT /api/board/<id>/settings, the route Team settings uses, once the launch has made the board. */
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
const { mountSettingsView } = await importOnce('./settings_view.js');
const { healthFields, healthToValues, valuesToHealth } = await importOnce('./team_health_fields.js');
const { HEALTH_DEFAULTS } = await importOnce('./team_health_settings.js');
const { requireGoalSentence } = await importOnce('./task_goals.js');

const ASKS_ARE_TASKS_HINT = 'When an agent needs another agent to do something, it creates a task. Plain posts are for questions and status.';
const WORKFLOW_HINT = 'Guidance the agents get on how to share the folder. It does not create worktrees.';

let _view = null;
let _defaultMode = 'none'; // the working mode a new team starts with: 'none', or the one the chosen team template names (#8919)

// What a new team starts with: nothing from the last team stays.
const startValues = () => ({ first_task: '', custom_instructions: '', mode: _defaultMode, dependency_guidance: false, asks_are_tasks: true, require_goal: false, ...healthToValues(HEALTH_DEFAULTS), cross_team_messaging: false, cross_team_artifacts: false });

// The health check's own rows, less who gets it: at launch that is the Orchestrator (a list of one is noise); another recipient is in Team settings.
const healthRows = () => healthFields({
    members: () => Promise.resolve([]), hasHeld: () => false, monitorOff: () => false, openSettings: () => {},
    onReset: view => { for (const [k, v] of Object.entries(healthToValues(HEALTH_DEFAULTS))) view.set(k, v); },
}).filter(f => f.key !== 'recipient' && !f.key.endsWith('_nudge')); // no members to pick from yet

/** Draw the step with a new team's own values (every time the team dialog opens: nothing from the last team stays). */
export function mountTeamLaunchSettings() {
    const host = document.getElementById('team-start-host');
    if (!host) return;
    if (_view) _view.destroy();
    _defaultMode = 'none';
    host.replaceChildren();
    _view = mountSettingsView(host, {
        mode: 'settings', saveBar: false, group: 'start', label: 'Team settings sections', groupLabel: 'Team settings section',
        load: async () => startValues(),
        groups: [
            { id: 'start', label: 'Start', icon: 'play_arrow', fields: [
                { key: 'first_task', type: 'textarea', id: 'team-goal', label: 'First task', help: 'Optional. It goes to the Orchestrator.', wide: true, rows: 4, placeholder: 'What should the team work on?', attrs: { maxlength: '2000' } },
                { key: 'custom_instructions', type: 'textarea', id: 'team-custom-instructions', label: 'Additional instructions', help: 'Optional.', wide: true, rows: 4, placeholder: 'Team-specific conventions' },
            ] },
            { id: 'workflow', label: 'Workflow', icon: 'account_tree', fields: [
                { key: 'mode', type: 'select', label: 'Working mode', help: WORKFLOW_HINT, options: [{ value: 'none', label: 'None' }, { value: 'shared_checkout', label: 'Shared checkout' }, { value: 'worktrees', label: 'Worktrees' }, { value: 'task_queue', label: 'Task queue' }] },
                { key: 'dependency_guidance', type: 'toggle', label: 'Guidance for dependent tasks' },
                { key: 'asks_are_tasks', type: 'toggle', label: 'Requests for work are tasks', help: ASKS_ARE_TASKS_HINT },
                { key: 'require_goal', type: 'toggle', label: 'Require a goal', help: requireGoalSentence },
            ] },
            { id: 'health', label: 'Health check', icon: 'health_and_safety', fields: healthRows() },
            { id: 'messaging', label: 'Messaging', icon: 'forum', fields: [
                { key: 'cross_team_messaging', type: 'toggle', label: 'Message teams on other computers', help: 'Through Coral Hub.' },
                { key: 'cross_team_artifacts', type: 'toggle', label: 'Share files with teams on other computers', help: 'Another team can message this team only when its Coral Hub account has linked the two teams and cross-team messaging is on here.' },
            ] },
        ],
    });
}

/**
 * What the step says: { working_mode, health_monitor, board, problem }. `working_mode` and `health_monitor` go in the launch request; `board` (null when nothing differs from a new team's
 * settings) is the PUT after it. `problem` is { text } for a field out of its range, with its tab open and the field focused.
 */
export function readTeamLaunchSettings() {
    const out = { working_mode: null, health_monitor: undefined, board: null, problem: null };
    if (!_view) return out;
    const check = _view.validate({ focus: true });
    if (!check.ok) { out.problem = { text: document.querySelector('#team-start-host .sv-error:not([hidden])')?.textContent?.trim() || 'Check the settings of this step.' }; return out; }
    const v = _view.values();
    const wm = { mode: v.mode || 'none', dependency_guidance: !!v.dependency_guidance, asks_are_tasks: !!v.asks_are_tasks, custom_instructions: String(v.custom_instructions || '').trim() };
    if (wm.mode !== 'none' || wm.dependency_guidance || wm.asks_are_tasks || wm.custom_instructions) out.working_mode = wm; // a new team has Requests for work are tasks on: it is sent unless the person turned it off
    const board = {};
    if (v.require_goal) board.require_goal = true;
    const h = valuesToHealth(v, HEALTH_DEFAULTS);
    if (h.on) out.health_monitor = true;
    if (JSON.stringify(h) !== JSON.stringify(HEALTH_DEFAULTS)) board.health = h;
    if (v.cross_team_messaging) board.cross_team_messaging = true;
    if (v.cross_team_artifacts) board.cross_team_artifacts = true;
    if (Object.keys(board).length) out.board = board;
    return out;
}

/** The working mode a team template names becomes the step's choice (and what it starts with if the step is still loading); the person can change it. */
export function setTeamLaunchMode(mode) {
    _defaultMode = mode;
    if (_view) _view.set('mode', mode);
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
