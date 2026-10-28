/* Moved out of modals.js as it was (#4684): The Launch dialog itself: choosing what to launch, opening it, the hub's server picker, the directory resets on a server change, Launch for an agent or a terminal, and the board select. No behaviour change. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { showToast, escapeHtml, escapeAttr, boardNameProblem } from './utils.js';
import { blockedReason } from './hub_access.js';
import { loadLiveSessions } from './api.js';
import { recordRecentDir, setDirServerResolver, getRecentDirs } from './browser.js';
import { pinnedFolders } from './pinned_folders.js';
import { defaultAgentName } from './session_state.js';
import { serverFetch, identityKey, isHub, normServer, LOCAL_SERVER, keyLabel, noteBoardLabels } from './server_base.js';
import { pickerVisible, pickerOptions, serverLabel, coerceSelection, bareBoardName } from './launch_server.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer, _loadServerSettings, _serverSettings, _settingsFor } = await importOnce('./launch_models.js');
const { defaultPermissionMode, syncDefaultPermissionMode, _normalizePermFlagsForAgent, _updatePermModeDescription, _hasPermFlag } = await importOnce('./permission_flags.js');
const { _checkAgentCLI } = await importOnce('./cli_check.js');
import { checkTmuxForLaunch } from './prerequisites.js';
import { sectionFocus } from './section_dialog.js';
import { showTeamAddress } from './team_form.js';
import { agentForm as folderForm, setAgentNameMode } from './agent_form.js';
const { _syncACFModelField, getAgentConfig, renderAgentConfigForm, cliWarningOf } = await importOnce('./agent_config_form.js');
const { _checkPermissionFlag } = await importOnce('./cli_dialogs.js');
const { _checkTeamGitDir, _initTeamForm, _loadExistingTeamBoards } = await importOnce('./team_dialogs.js');
const { _initAgentPresets } = await importOnce('./persona_io.js');
const { quietFocus } = await importOnce('./quiet_focus.js');
const { markFieldInvalid, _launchBlocked, _launchOn, _refreshAfterLaunch, _resetDirInputs, _showLaunchStep, _syncMobileLaunchSections, _withServerSettings, hideLaunchModal, setLaunchMore, setLaunchStage, LAUNCH_STAGES, launchStages } = await importOnce('./launch_core.js');
const { wireRecap, syncRecap } = await importOnce('./launch_recap.js');

/** New Agent's three steps (#7391): Next goes from the folder to the persona to the agent (a folder is needed first), Back returns. `arg` is a stage name, "next" or "back" (the old "details" is the persona step). Focus follows, and a screen reader hears which step. */
function _launchStage(arg) {
    const step = document.getElementById('launch-step-agent');
    const stages = launchStages(), cur = step?.dataset.stage || stages[0], at = Math.max(0, stages.indexOf(cur));
    const to = arg === 'details' ? 'persona' : arg === 'next' ? stages[Math.min(at + 1, stages.length - 1)] : arg === 'back' ? stages[Math.max(at - 1, 0)] : arg;
    if (!stages.includes(to)) return;
    const input = document.getElementById('launch-dir');
    if (to !== 'folder' && !launch.member && (!input || !input.value.trim())) { // a folder is the one thing a launch needs (a team member is not launched: it has none, #7861): said where it is, on the folder's own step
        setLaunchStage('folder');
        _folderPressed = true; folderForm()?.validate({ focus: true }); _syncLaunchBlock(); // the folder is flagged under it, and one red line above the buttons says it
        return;
    }
    const list = document.getElementById('dir-browser'); if (list) list.style.display = 'none'; // display-ok: the folder list is shown and hidden by style.display where it is opened (browser.js)
    const sub = setLaunchStage(to);
    syncRecap(); _syncLaunchBlock();
    const live = document.getElementById('launch-stage-live');
    if (live) live.textContent = sub || '';
    const first = to === 'folder' ? input : to === 'persona' ? document.querySelector('#launch-step-agent .agent-preset-select') : sectionFocus(document.getElementById('launch-step-agent'));
    if (to === 'agent') quietFocus(document.getElementById('launch-modal')); // the selected tab takes the focus: no ring until a key is pressed (#7391)
    first?.focus();
}
window._launchStage = _launchStage;

function _selectLaunchType(type) {
    if (type === "back" && launch.member) { window.cancelTeamMember?.(); return; } // the arrow on a member goes back to the team form (#7861)
    if (type === "back" && document.getElementById('launch-step-agent')?.dataset.stage === 'details' && document.getElementById('launch-step-agent').style.display !== 'none') { _launchStage('folder'); return; } // the arrow goes back one step first
    if (type === "back") {
        launch.mode = null;
        _showLaunchStep("chooser");
        return;
    }
    launch.mode = type;
    if (type === "agent") setLaunchMore(false); // New Agent always opens on step 1, the folder (#7391)
    _showLaunchStep(type);
    if (type === "agent") {
        if (!launch.addTo && !launch.member) { // New Agent: its own title and no team (Add agent and a member set both below, #7778, #7861)
            document.getElementById('launch-modal')?.removeAttribute('data-add-to');
            setAgentNameMode(false); // a member's field is its Role, and a role is required
            const t = document.getElementById('launch-agent-title-text'); if (t) t.textContent = 'New agent';
        }
        _loadAgentBoardProjects();
        document.getElementById('agent-preset-selector')?.replaceChildren(); // a new dialog starts from Blank again (#7391)
        _initAgentPresets();
        // Render agent config form
        renderAgentConfigForm('launch-agent-acf', {
            showPreset: false,
            showName: false,
            cliSlot: 'launch-cli-slot', // a missing CLI is said under the provider, in the reserved note slot (#5835, #7391)
            sections: true, // step 3 is a sectioned dialog (#4950): Agent, Permissions, Advanced
            wizard: true, // the persona page for step 2 and three panes for step 3 (#7391)
            adopt: { persona: 'launch-persona-top', agent: 'launch-agent-provider', advanced: 'launch-advanced-extra' },
            adoptEnd: { agent: 'launch-note-slot' }, // the provider's notes have their room at the END of the Agent pane, under Thinking: nothing above it moves when a note appears (#8528)
            value: launch.member ? launch.member.value : { agentType: _settingsFor(_effectiveServer(launch.server)).default_agent_type || 'claude' }, // a member's own values (#7861)
        });
        // The agent is chosen in this step, not only under More options (#6199): a radio group that follows the form's own select, the installed agents first.
        importOnce('./launch_agent_pick.js').then(m => m.buildAgentPick({ group: document.getElementById('launch-agent-pick'), form: document.getElementById('launch-agent-acf'), server: _effectiveServer(launch.server), implicitDefault: !_settingsFor(_effectiveServer(launch.server)).default_agent_type })).catch(() => {});
        _folderPressed = false; folderForm()?.clearErrors();
        _wireDirNote(); _syncDirNote(); _syncLaunchBlock(); _renderDirRecents();
        wireRecap(); syncRecap(); _syncLaunchBlock();
        _checkTmuxHere(); // tmux missing: said once, Launch off (#6046)
        if (launch.member) _applyMember(); else if (launch.addTo) _applyAddTo(); else document.getElementById('launch-dir')?.focus(); // the one thing most launches need: the folder
    } else if (type === "team") {
        launch.teamAddress = false;
        _renderServerPicker(); // the Machine list, with its address entry for a team (#7407)
        _initTeamForm();
        _checkTmuxHere();
        document.getElementById('team-board-name')?.focus();
    } else {
        _defaultTerminalDir();
        document.getElementById("launch-terminal-name").focus();
    }
}

/** A terminal opens in the folder the person keeps in their list, not in the home folder (#10077): the Settings default, else the first folder they opened. A folder they typed stays. */
function _defaultTerminalDir() {
    const input = document.getElementById('launch-terminal-dir');
    if (!input || _effectiveServer(launch.server) !== LOCAL_SERVER) return;
    const now = input.value.trim().replace(/[\\/]+$/, ''), root = (input.dataset.coralRoot || '').replace(/[\\/]+$/, '');
    if (now && now !== root) return;
    const pin = pinnedFolders().find(p => p.exists !== false);
    const dir = _settingsFor(LOCAL_SERVER).default_working_dir || (pin && pin.path) || '';
    if (dir) input.value = dir;
}
window._selectLaunchType = _selectLaunchType;

/**
 * Open the launch modal. `server` (hub mode) pre-selects a launch target; with
 * `lock` the dropdown is fixed to it (launches started from inside a remote
 * context). Default is the hub itself with a free choice.
 */
export function showLaunchModal(server, lock = false) {
    launch.mode = null;
    launch.addTo = null; // a New Agent dialog is not an Add agent one (#7778)
    launch.member = null; // nor a member's (#7861)
    _serverSettings.clear();
    launch.serverLocked = !!lock && isHub();
    launch.server = _effectiveServer(coerceSelection(server, isHub(), state.servers));
    if (launch.serverLocked && normServer(server) !== LOCAL_SERVER) launch.server = normServer(server);
    _renderServerPicker();
    document.getElementById("launch-modal").style.display = "flex";
    _showLaunchStep("chooser");

    // Reset agent form
    const agentNameInput = document.getElementById("launch-agent-name-input");
    if (agentNameInput) agentNameInput.value = "";
    document.getElementById("launch-board-name").value = "";
    document.getElementById("launch-board-server").value = "";
    const agentBoardSelect = document.getElementById("launch-board-select");
    if (agentBoardSelect) agentBoardSelect.value = "";
    document.getElementById("launch-new-board-row").style.display = "none";
    document.getElementById("launch-board-server-row").style.display = "none";

    // Reset terminal form
    document.getElementById("launch-terminal-name").value = "";

    // Reset team form
    document.getElementById("team-agents-list").innerHTML = "";
    document.getElementById("team-board-name").value = "";
    const teamFlagsEl = document.getElementById("team-flags");
    if (teamFlagsEl) teamFlagsEl.value = "";
    const teamPermModeEl = document.getElementById("team-permission-mode");
    if (teamPermModeEl) {
        delete teamPermModeEl.dataset.pickedByPerson; // a new dialog: the default again, for the agent type the team starts with (#5836)
        const teamSettings = _settingsFor(_effectiveServer(launch.server));
        syncDefaultPermissionMode(teamPermModeEl, teamSettings, teamSettings.default_agent_type || 'claude');
        _updatePermModeDescription(teamPermModeEl);
    }

    // Pre-fill from the target server's settings (the hub's own when local)
    _resetLaunchDirs(launch.server);
    const s = _settingsFor(launch.server);
    const typeSelect = document.getElementById("launch-type");
    if (s.default_agent_type && typeSelect) {
        typeSelect.value = s.default_agent_type;
    }

    _syncMobileLaunchSections();
    _syncLaunchAccess();
    if (launch.server !== LOCAL_SERVER) _onLaunchServerChange(launch.server, { force: true });
}

// ── Server picker (hub mode) ─────────────────────────────────────────────

/** Fill and show/hide a Server dropdown. Hidden unless hub mode has a usable remote. */
function _renderServerPicker() {
    const row = document.getElementById('launch-server-row');
    const sel = document.getElementById('launch-server');
    if (!row || !sel) return;
    const current = launch.server;
    const locked = launch.serverLocked;
    const show = isHub() && (locked ? current !== LOCAL_SERVER : pickerVisible(true, state.servers));
    if (!show) { row.style.display = 'none'; return; }
    let opts = pickerOptions(state.servers);
    if (!opts.some(o => o.id === current)) opts = [...opts, { id: current, label: current, disabled: false }];
    sel.innerHTML = opts.map(o =>
        `<option value="${escapeAttr(o.id)}"${o.disabled ? ' disabled' : ''}>${escapeHtml(o.label)}</option>`).join('');
    // A team can also start on a computer that is not in the list: its last entry reveals the address field (#7407).
    if (launch.mode === 'team' && !locked) sel.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(TEAM_ADDRESS)}">Another computer's address\u2026</option>`);
    sel.value = launch.mode === 'team' && launch.teamAddress ? TEAM_ADDRESS : current;
    sel.disabled = locked;
    row.style.display = 'flex';
}

const TEAM_ADDRESS = '__address__';
/** Show the address field when the Machine is "Another computer's address..." (the field is in step 1, in its own slot); nothing typed there survives another choice. */
function _syncTeamAddress(on) {
    launch.teamAddress = !!on;
    const input = document.getElementById('team-board-server');
    showTeamAddress(on);
    if (input) { input.disabled = !on; if (!on) input.value = ''; }
    if (on) input?.focus();
}

const _LAUNCH_DIR_IDS = ['launch-dir', 'launch-terminal-dir', 'launch-team-dir'];
const _LAUNCH_BROWSER_IDS = ['dir-browser', 'dir-browser-terminal', 'dir-browser-team'];


function _resetLaunchDirs(server, opts) {
    // The team dir is also filled by _initTeamForm; only touch it on a switch
    // or for a remote so local behaviour with hub off is unchanged.
    const ids = (opts && opts.switching) || server !== LOCAL_SERVER ? _LAUNCH_DIR_IDS : _LAUNCH_DIR_IDS.slice(0, 2);
    _resetDirInputs(ids, server, _settingsFor(server), opts);
    for (const id of _LAUNCH_BROWSER_IDS) {
        const b = document.getElementById(id);
        if (b) b.style.display = 'none';
    }
}

/** Reload everything that depends on the launch server after the dropdown changes. */
async function _onLaunchServerChange(value, { force = false } = {}) {
    if (value === TEAM_ADDRESS) { _syncTeamAddress(true); return; } // the machine stays; the address is typed
    if (launch.mode === 'team' && launch.teamAddress) _syncTeamAddress(false);
    const next = _effectiveServer(coerceSelection(value, isHub(), state.servers));
    if (next === launch.server && !force) return;
    const prev = launch.server;
    launch.server = next;
    _syncLaunchAccess();
    const note = document.getElementById('launch-server-note');
    if (note) note.textContent = next === LOCAL_SERVER ? '' : 'Loading…';
    // Nothing from the previous server may survive: directory, board server, board choice.
    _resetLaunchDirs(next, { switching: next !== prev || force });
    for (const id of ['launch-board-server', 'team-board-server']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    }
    let loadError = '';
    if (next !== LOCAL_SERVER) {
        try { await _loadServerSettings(next); } catch (e) { loadError = e.message || 'unreachable'; }
        if (launch.server !== next) return; // changed again while loading
    }
    if (note) note.textContent = loadError ? `Could not read ${serverLabel(next, state.servers)}: ${loadError}` : '';
    // Re-apply defaults from the (now loaded) settings, then the dependent option sources.
    _resetLaunchDirs(next, { switching: true });
    const s = _settingsFor(next);
    const typeSelect = document.getElementById('launch-type');
    if (s.default_agent_type && typeSelect) typeSelect.value = s.default_agent_type;
    if (launch.mode === 'agent' || launch.mode === 'team') _checkTmuxHere();
    if (launch.mode === 'agent') { _loadAgentBoardProjects(); _renderDirRecents(); }
    if (launch.mode === 'team') { _loadExistingTeamBoards(); _checkTeamGitDir(); }
    document.querySelectorAll('#launch-modal [data-acf-uid]').forEach(c => {
        if (c.querySelector('.acf-agent-type')) {
            _syncACFModelField(c);
            _checkAgentCLI(c.querySelector('.acf-agent-type').value || 'claude', cliWarningOf(c));
        }
    });
}
window._onLaunchServerChange = _onLaunchServerChange;

// Directory inputs belong to whichever server their form launches on.
setDirServerResolver(inputId => {
    if (!isHub()) return LOCAL_SERVER;
    if (inputId === 'resume-dir') return LOCAL_SERVER; // resume uses the hub's own session history
    return launch.server;
});


// Through the Coral Hub a machine at View (or Interact) refuses a launch: say so when the form opens, with the launch buttons dimmed, instead of after it is filled in (#4586).
// The buttons stay clickable; a click says the same reason in one toast (_launchBlocked).
function _syncLaunchAccess() {
    const modal = document.getElementById('launch-modal');
    if (!modal) return;
    const why = isHub() ? blockedReason(_effectiveServer(launch.server), 'launch') : '';
    const note = document.getElementById('launch-access-note');
    if (note) note.textContent = why; // always in the page, only its text changes (a status that appears with its words is often not read)
    for (const b of modal.querySelectorAll('[data-on-click="m-launch-session"], [data-on-click="m-launch-team"]')) {
        b.classList.toggle('hub-blocked', !!why);
        if (why) { b.setAttribute('aria-disabled', 'true'); b.title = why; } else { b.removeAttribute('aria-disabled'); b.removeAttribute('title'); }
    }
}
document.addEventListener('coral:server-access-loaded', () => { if (document.getElementById('launch-modal')?.style.display === 'flex') _syncLaunchAccess(); });

// A missing CLI is said once, under the folder, and Launch stays off until it is there (#5990); the message is the button's reason.
let _folderPressed = false; // Next was pressed with no folder: only then is it said above the buttons (nothing before the first press)
const _cliBlock = () => document.querySelector('#launch-step-agent [data-blocks-launch]');
function _syncLaunchBlock() {
    const go = document.getElementById('launch-agent-go'), next = document.getElementById('launch-agent-next');
    if (!go) return;
    const why = _cliBlock();
    go.disabled = !!why;
    // The reason Launch is off is its description (#7391): the missing CLI's line. A missing folder never turns a button off: pressing Next says it where the folder is (one red line above the buttons, the error under the field).
    const noDir = !launch.member && !(document.getElementById('launch-dir')?.value || '').trim();
    const status = document.getElementById('launch-agent-status');
    if (status && (_folderPressed || status.textContent === 'Choose a folder')) status.textContent = _folderPressed && noDir ? 'Choose a folder' : ''; // the folder's line only: a member's role line is said by the member's own save
    for (const b of [go, next]) {
        if (!b) continue;
        b.removeAttribute('aria-disabled');
        if (b === go && why) { b.setAttribute('aria-describedby', why.id ||= 'launch-cli-warning'); } else b.removeAttribute('aria-describedby');
    }
}
document.addEventListener('cli-blocks-launch', e => { if (e.target.closest && e.target.closest('#launch-step-agent')) _syncLaunchBlock(); });
// The tmux line is about this computer: a launch on another server (a local multi-server hub) is reported by that server's own launch (#6046).
const _launchIsLocal = () => _effectiveServer(launch.server) === LOCAL_SERVER;
function _checkTmuxHere() {
    const id = launch.mode === 'team' ? 'team-tmux-slot' : 'launch-tmux-slot';
    checkTmuxForLaunch(document.getElementById(id), { isLocal: _launchIsLocal });
}

// A team launch on a machine without tmux says it once too, and Launch Team stays off (#6046).
function _syncTeamBlock() {
    const go = document.getElementById('launch-team-go');
    if (!go) return;
    const why = document.querySelector('#launch-step-team [data-blocks-launch]');
    go.disabled = !!why;
    // Launch team is described by the lines that say why it is off: the line above the buttons for a member's CLI (that warning is on a page this step does not show, #9945), and the tmux line itself when
    // tmux is what is missing (the line above the buttons does not carry that one: it is in its own slot, #6046). Both, when both hold it.
    const ids = [];
    if (document.querySelector('#launch-step-team [data-blocks-launch]:not(#team-tmux-slot)')) ids.push('team-recap');
    if (document.querySelector('#team-tmux-slot[data-blocks-launch]')) ids.push('team-tmux-slot');
    if (why && ids.length) go.setAttribute('aria-describedby', ids.join(' ')); else go.removeAttribute('aria-describedby');
}
document.addEventListener('cli-blocks-launch', e => { if (e.target.closest && e.target.closest('#launch-step-team')) _syncTeamBlock(); });

// The first step helps with the folder (#6370 item 3): the last three folders as buttons (a repeat launch is one click), and for a person who has used none, one line that says what to pick.
function _renderDirRecents() {
    const box = document.getElementById('launch-dir-recents'), hint = document.getElementById('launch-dir-hint');
    if (!box || !hint) return;
    const dirs = getRecentDirs(_effectiveServer(launch.server)).slice(0, 3);
    box.replaceChildren(...(dirs.length ? [Object.assign(document.createElement('span'), { className: 'launch-recent-label', textContent: 'Recent:' })] : []), ...dirs.map(d => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-small launch-dir-recent'; b.title = d; b.dataset.dir = d; b.setAttribute('data-on-click', 'launch-dir-recent');
        b.textContent = d.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || d;
        return b;
    }));
    hint.textContent = ''; // the Browse button and the field's own placeholder say it: no line under the label (#7064)
    hint.hidden = true;
}

// The home folder is a wide place to start an agent in: the person may choose it, and one line says what that means (#5990).
function _syncDirNote() {
    const input = document.getElementById('launch-dir'), note = document.getElementById('launch-dir-note');
    if (!input || !note) return;
    const v = input.value.trim().replace(/[\\/]+$/, '');
    const root = (input.dataset.coralRoot || '').replace(/[\\/]+$/, '');
    const on = !!(v && (v === '~' || (!input.dataset.dirServer && root && v === root)));
    // A note read when the person is at the Folder field, not a live region (#6656): it describes the field while it applies, so it is read with it and not announced from nowhere.
    if (note.hidden === on) note.hidden = !on;
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== 'launch-dir-note'); // the form's own error line stays in the description
    if (on) ids.push('launch-dir-note');
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
}
function _wireDirNote() {
    const input = document.getElementById('launch-dir');
    if (!input || input.dataset.noteWired) return;
    input.dataset.noteWired = '1';
    input.addEventListener('input', _syncDirNote); input.addEventListener('change', _syncDirNote);
    input.addEventListener('input', _syncLaunchBlock); input.addEventListener('change', _syncLaunchBlock); // Next and Launch say why they are off until there is a folder
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); _launchStage('next'); } }); // Enter is Next
}


/**
 * Add agent (#7778, the operator: "the same flow as New Agent"): New Agent's own dialog with the team (or the folder group) it starts from preset. The folder is the one the team or group works in, so the dialog starts
 * at the persona and has two steps, persona then the agent (Next, Back); the team is named in the title, joined by id as the Message Board field of step 3 would, and cannot be changed (the field is not shown).
 * With no folder (a team that has none) the folder step stays. `board` is the team's key ("@server/name" for a remote), '' for an agent of a folder group; `server` is the one the team or folder is on.
 */
export function showAddAgentFlow({ board = '', workDir = '', server } = {}) {
    server = _effectiveServer(server);
    if (_launchBlocked(server)) return;
    _serverSettings.delete(server);
    _withServerSettings(server, () => {
        showLaunchModal(server, true);
        launch.addTo = { board, workDir, skipFolder: !!workDir };
        _selectLaunchType('agent');
    });
}

/**
 * Add member / Edit member (#7861): the agent step of this dialog in a second mode, over the team form (team_dialogs.js showTeamAgentModal sets launch.member and asks for it). The member's values are loaded, the
 * persona step is the role and prompt (Back from the settings), and Save member (not Launch) writes the member into the team form; Cancel, the arrow and Escape return to the team form unchanged.
 */
function _applyMember() {
    const m = launch.member;
    if (!m) return;
    document.getElementById('launch-modal')?.setAttribute('data-member', m.row ? 'edit' : 'add');
    const title = document.getElementById('launch-agent-title-text');
    if (title) title.textContent = m.row ? 'Edit member' : 'Add member';
    const name = document.getElementById('launch-agent-name-input');
    if (name) name.value = m.value.name || '';
    setAgentNameMode(true); // the role: Required, Save member needs it
    _syncLaunchBlock();
    _launchStage(m.row ? 'agent' : 'persona'); // an existing member opens on its settings, a new one on its role
    if (!m.row) name?.focus(); // the role is the first thing a new member needs
    // A member that has its own role and prompt is not "Blank: no persona": the persona choice says Custom (#10314); a new member keeps Blank
    const pick = document.getElementById('launch-persona-select');
    if (pick && m.row && (m.value.name || m.value.prompt)) {
        if (!pick.querySelector('option[value="__custom__"]')) { const o = document.createElement('option'); o.value = '__custom__'; o.textContent = "Custom: this member's own role and prompt"; pick.options[0].after(o); }
        pick.value = '__custom__';
    }
}

/** The parts of Add agent that the dialog shows: the title, the folder, and where it starts. */
function _applyAddTo() {
    const a = launch.addTo;
    if (!a) return;
    document.getElementById('launch-modal')?.setAttribute('data-add-to', a.board ? 'team' : 'folder');
    const title = document.getElementById('launch-agent-title-text');
    if (title) title.textContent = a.board ? `Add agent to ${keyLabel(a.board)}` : 'Add agent';
    const dir = document.getElementById('launch-dir');
    if (dir && a.workDir) dir.value = a.workDir;
    _syncDirNote(); syncRecap(); _syncLaunchBlock();
    _launchStage(a.skipFolder ? 'persona' : 'folder');
}

export async function launchSession() {
    let dir, type, agentName, flagsStr, backend, permPick;
    if (launch.mode !== 'terminal' && _cliBlock()) return; // the CLI it needs is missing: the message under the folder says so

    if (launch.mode === "terminal") {
        dir = document.getElementById("launch-terminal-dir").value.trim();
        type = "terminal";
        agentName = document.getElementById("launch-terminal-name").value.trim();
        flagsStr = "";
        backend = document.getElementById("launch-terminal-backend")?.value;
    } else {
        dir = document.getElementById("launch-dir").value.trim();
        const config = getAgentConfig('launch-agent-acf');
        type = config.agentType || 'claude';
        agentName = document.getElementById("launch-agent-name-input")?.value.trim() || config.name;
        flagsStr = config.flags;
        permPick = config.permissionMode;
        backend = document.getElementById("launch-backend")?.value;
    }

    if (!dir) {
        const agentForm = launch.mode !== "terminal";
        if (agentForm) setLaunchMore(false); // the folder is step 1: back to it, so the flagged field can take the focus
        if (agentForm) { _folderPressed = true; folderForm().validate({ focus: true }); _syncLaunchBlock(); } else markFieldInvalid(document.getElementById("launch-terminal-dir"), "Working directory is required");
        return;
    }

    // Everything below (directory, CLI, defaults) is interpreted on this server.
    const server = _effectiveServer(launch.server);
    if (_launchBlocked(server)) return;

    // Permission flag check (skip for terminals)
    if (launch.mode !== "terminal") {
        const permResult = await _checkPermissionFlag(flagsStr, type, server, permPick);
        if (permResult === null) return;
        if (permResult === 'enable') {
            const mode = defaultPermissionMode(_settingsFor(server), type);
            flagsStr = _normalizePermFlagsForAgent(flagsStr, type, mode);
        }
    }

    const payload = { working_dir: dir, agent_type: type };
    // Default picked (and Keep Default in "Default mode waits for you") is Default: the form sends no flag for it, which the server cannot tell from "nothing chosen" (that starts in the saved default or Auto), so the request says it (#10362).
    if (launch.mode !== "terminal" && permPick === 'default' && !(flagsStr && _hasPermFlag(flagsStr))) payload.permission_mode = 'default';
    if (agentName) payload.display_name = agentName;
    if (backend && !launch.addTo) payload.backend = backend; // Add agent sends what it always sent: the server's own default backend (#7778)

    if (flagsStr) {
        payload.flags = flagsStr.split(/\s+/);
    }

    // Agent config from ACF (only for agent mode)
    if (launch.mode !== "terminal") {
        const config = getAgentConfig('launch-agent-acf');
        if (config.capabilities) payload.capabilities = config.capabilities;
        if (config.prompt) payload.prompt = config.prompt;
        if (config.model) payload.model = config.model;
        if (config.thinking !== undefined) payload.thinking = config.thinking; // chosen on the form (#4969)

        const boardSelect = document.getElementById("launch-board-select");
        if (boardSelect && boardSelect.value) {
            if (boardSelect.value === "__new__") {
                const boardName = document.getElementById("launch-board-name").value.trim();
                if (boardName) {
                    const problem = boardNameProblem(boardName);
                    if (problem) { showToast(problem, true); markFieldInvalid(document.getElementById("launch-board-name"), problem); return; }
                    payload.board_name = boardName;
                }
            } else {
                // An existing board joins by its id (#3536); board_name is the same key, for a Coral
                // from before board ids.
                payload.board_id = payload.board_name = bareBoardName(boardSelect.value);
            }
            const boardServer = document.getElementById("launch-board-server").value.trim();
            if (boardServer) payload.board_server = boardServer;
        }
    }
    // The board select lists the target server's own boards (bare names).
    if (payload.board_name) payload.board_name = bareBoardName(payload.board_name);

    // Disable launch button to prevent double-clicks
    const stepId = launch.mode === "terminal" ? "launch-step-terminal" : "launch-step-agent";
    const launchBtn = launch.mode === "terminal" ? document.querySelector(`#${stepId} .btn-primary`) : document.getElementById('launch-agent-go');
    if (launchBtn) { launchBtn.disabled = true; launchBtn.textContent = 'Launching...'; }

    try {
        const dirInput = document.getElementById(launch.mode === "terminal" ? "launch-terminal-dir" : "launch-dir");
        const result = await _launchOn(server, "/api/sessions/launch", payload, type, { dirInput, retry: launchSession }); // the Not Found dialog's Check again launches again, from this dialog's own fields
        if (result) {
            recordRecentDir(dir, server);
            // The agent as the list names it (its name, else its folder or CLI, or "Terminal"), not the session's raw id (#5895)
            const shown = agentName || (type === 'terminal' ? 'Terminal' : defaultAgentName(dir, type));
            const addedTo = launch.addTo && launch.addTo.board ? ` on board ${keyLabel(launch.addTo.board)}` : '';
            const added = !!(launch.addTo && launch.addTo.board); // Add agent to a team opens nothing: the person is on the team's page (#7778); one into a folder opens the new agent (#10077)
            showToast(server === LOCAL_SERVER ? `Launched: ${shown}${addedTo}` : `Launched on ${serverLabel(server, state.servers)}: ${shown}${addedTo}`);
            const opener = document.getElementById('launch-modal')._focusOpener || null; // where the keyboard was when the dialog opened: closing the dialog puts it back there (#10247)
            hideLaunchModal();
            importOnce('./alerts_offer.js').then(m => m.offerAlertsAfterLaunch()).catch(() => {}); // the first agent is when alerts make sense: once per browser (#10068)
            setTimeout(loadLiveSessions, 2000);
            _refreshAfterLaunch(server, { sessionName: result.session_name, sessionId: result.session_id });
            if (normServer(server) === LOCAL_SERVER && !added) _openLaunched(result, type, opener);
        }
    } catch (e) {
        showToast("Could not start the agent. Check that the folder exists and that the agent is installed, then try again.", true);
    } finally {
        if (launchBtn) { launchBtn.disabled = false; launchBtn.textContent = 'Launch'; }
        if (launch.mode !== 'terminal') _syncLaunchBlock();
    }
}

/** Open what was just launched (#5835): a person who pressed Launch expects to land in the new agent, not on the home screen with a row to find (the first run's biggest drop:
 *  launched, never prompted). The list is read first so the row exists; the composer is focused by selecting it. A failure leaves the toast and the row, as before. */
export async function _openLaunched(result, type, opener = null) {
    try {
        await loadLiveSessions();
        const { selectLiveSession } = await importOnce('./sessions.js');
        await selectLiveSession(result.session_name, type, result.session_id, LOCAL_SERVER);
        // The keyboard goes into the new agent's message box, where the person types next: closing the dialog had put it back on the button that opened it (or, on a phone, where that button is gone, on the page).
        // Somewhere else, because the person moved it while the agent opened, it stays (#10247).
        const now = document.activeElement, box = document.getElementById('command-input');
        if ((!now || now === document.body || now === opener) && box && box.getClientRects().length > 0) box.focus();
    } catch { /* the toast and the list row are still there */ }
}

// ── Agent Board Select ────────────────────────────────────────────────────

async function _loadAgentBoardProjects() {
    const select = document.getElementById("launch-board-select");
    if (!select) return;
    select.innerHTML = '<option value="">None</option><option value="__new__">Create new board...</option>';
    // Add agent (#7778): the team is the one it was opened from: it is the select's value, and the field is not shown (nor is anything that would change it).
    const preset = launch.addTo && launch.addTo.board ? bareBoardName(launch.addTo.board) : '';
    const label = select.closest('.form-row');
    if (label) label.hidden = !!(launch.addTo && launch.addTo.board) || !!launch.member;
    const serverRowEl = document.getElementById('launch-board-server-row'); if (serverRowEl) serverRowEl.hidden = false; // New Agent shows it as before (its own style decides)
    if (preset) {
        const opt = document.createElement('option');
        opt.value = preset;
        opt.textContent = keyLabel(launch.addTo.board);
        select.appendChild(opt);
        select.value = preset;
        _onAgentBoardChange();
        const serverRow = document.getElementById('launch-board-server-row'); if (serverRow) serverRow.hidden = true; // a team on this Coral: no remote server to name
    }
    try {
        // Boards that exist on the server the agent will launch on.
        const server = _effectiveServer(launch.server);
        const resp = await serverFetch(server, "/api/board/projects");
        const projects = await resp.json();
        if (!Array.isArray(projects) || server !== _effectiveServer(launch.server)) return;
        noteBoardLabels(projects, 'project', server);
        for (const p of projects) {
            if (preset && p.project === preset) continue; // already the one option, and selected
            const opt = document.createElement("option");
            opt.value = p.project;
            opt.textContent = keyLabel(identityKey(server, p.project)); // its label, with a short id when two share it
            select.appendChild(opt);
        }
    } catch (_) {}
}

function _onAgentBoardChange() {
    const select = document.getElementById("launch-board-select");
    const newRow = document.getElementById("launch-new-board-row");
    const serverRow = document.getElementById("launch-board-server-row");
    const hasBoard = select.value && select.value !== "";
    newRow.style.display = select.value === "__new__" ? "" : "none";
    serverRow.style.display = hasBoard ? "" : "none";
    if (!hasBoard) document.getElementById("launch-board-server").value = "";
}
window._onAgentBoardChange = _onAgentBoardChange;
