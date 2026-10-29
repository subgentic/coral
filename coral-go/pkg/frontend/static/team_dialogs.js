/* Moved out of modals.js as it was (#4684): The AI team wizard, the team-agent dialog, and the Launch dialog's team form: its agents, templates and Launch Team. No behaviour change. */
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';
import { scrollBehavior } from './motion.js';
import { showToast, escapeHtml, escapeAttr, boardNameProblem, OPERATOR_ID } from './utils.js';
import { loadLiveSessions } from './api.js';
import { recordRecentDir, getRecentDirs } from './browser.js';
import { teamForm, showTeamWorktree, showTeamWorkers } from './team_form.js';
import { agentNameForm, agentStatus } from './agent_form.js';
import { cliPathButton } from './prerequisites.js';
import { serverFetch, boardFetch, identityKey, LOCAL_SERVER } from './server_base.js';
const { launch } = await importOnce('./launch_state.js');
const { _acfServer, _effectiveServer, _settingsFor } = await importOnce('./launch_models.js');
const { trackPermissionPick, _getPermissionFlagsForAgentMode, _normalizePermFlagsForAgent, _updatePermModeDescription, _hasPermFlag } = await importOnce('./permission_flags.js');
const { _findPersona, _getSavedTeamTemplates, _upsertSavedTeamTemplates } = await importOnce('./persona_store.js');
const { getAgentConfig, renderAgentConfigForm, setAgentConfig, resetProviderChoices } = await importOnce('./agent_config_form.js');
const { markFieldInvalid, _launchBlocked, _launchOn, _onServerSuffix, _refreshAfterLaunch, _resetDirInputs, _showLaunchStep, hideLaunchModal, showTeamLaunchFailures } = await importOnce('./launch_core.js');
const { _syncFlagButtons } = await importOnce('./flag_shortcuts.js');
const { showSettingsModal } = await importOnce('./settings_dialog.js');
const { modelName, levelName } = await importOnce('./model_labels.js');
const { launchedMode } = await importOnce('./preset_enforcement.js');
const { BUILTIN_TEAM_TEMPLATES, DEFAULT_TEAM_KEY, GENERATED_TEAM_KEY, _renderTeamTemplateSelector, _syncTemplateMenu, markTeamTemplate, resetTeamTemplatePicker } = await importOnce('./team_templates_ui.js');
const { showTeamStep, currentTeamStep, TEAM_STEPS } = await importOnce('./team_steps.js');
const { mountTeamLaunchSettings, readTeamLaunchSettings, applyTeamBoardSettings, setTeamLaunchMode } = await importOnce('./team_launch_settings.js');


const _modeLabel = v => [...(document.getElementById('team-permission-mode')?.options || [])].find(o => o.value === v)?.textContent || v;

// A member counts as the Orchestrator when its role is exactly the word, in any case and with spaces round it: the server reads it the same way (#7407).
const isOrchestrator = name => String(name || '').trim().toLowerCase() === 'orchestrator';
const teamRows = () => [...document.querySelectorAll('#team-agents-list .team-agent-row')];
const rowRole = row => ((row.dataset.acfId ? getAgentConfig(row.dataset.acfId).name : '') || '').trim();
const hasOrchestrator = () => teamRows().some(r => isOrchestrator(rowRole(r)));
/** The row that gets the first task: the Orchestrator, else the first member (what _openLaunchedTeam posts to). */
const leadRow = () => teamRows().find(r => isOrchestrator(rowRole(r))) || teamRows()[0] || null;

// A member follows the team's provider unless it was given one (a template's own, or one picked in the dialog): the form's select is set from the team's, so the launch sends it.
function _followTeamType() {
    const type = document.getElementById('team-agent-type')?.value;
    if (!type) return;
    for (const row of document.querySelectorAll('#team-agents-list .team-agent-row[data-follows-team-type="1"]')) {
        const sel = document.getElementById(row.dataset.acfId)?.querySelector('.acf-agent-type');
        if (sel && sel.value !== type) { sel.value = type; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }
}

// One quiet line under the role: "Claude · default model · default mode"; what the member changed is bold ("Claude · Opus 5.5 · High thinking · Plan mode").
function _updateTeamAgentSummary(row) {
    if (!row) return;
    const acfId = row.dataset.acfId;
    const config = acfId ? getAgentConfig(acfId) : {};
    const name = config.name || 'New member';
    const typeSelect = document.getElementById('team-agent-type');
    const typeLabel = v => [...(typeSelect?.options || [])].find(o => o.value === v)?.textContent.replace(/ \(.*\)$/, '') || v;
    const type = config.agentType || typeSelect?.value || 'claude';
    const parts = []; // [text, changed]
    parts.push([typeLabel(type), false]);
    const modelId = config.model || '';
    parts.push([modelId ? modelName(type, modelId, _effectiveServer(launch.server)) : 'default model', !!modelId && modelId !== _settingsFor(_effectiveServer(launch.server))['default_model_' + type]]);
    if (config.thinking) parts.push([`${levelName(config.thinking)} thinking`, true]);
    // What launches (#6425): the member's own Mode, else the team's, is applied; for Codex and Antigravity the capabilities may only narrow it, and with no Mode they decide.
    const acf = acfId ? document.getElementById(acfId) : null;
    const ownMode = acf?.querySelector('.acf-permission-mode')?.value || 'default';
    const teamMode = document.getElementById('team-permission-mode')?.value || 'default';
    const mode = ownMode !== 'default' ? ownMode : teamMode;
    const lm = launchedMode(type, mode, config.capabilities);
    parts.push([lm.narrowed ? lm.text : `${_modeLabel(mode)} mode`.replace(/^Default mode$/, 'default mode'), mode !== 'default' || !!lm.narrowed, !!lm.warn]);
    const line = row.querySelector('.team-agent-summary');
    if (line) {
        line.replaceChildren();
        parts.forEach(([text, changed, warn], i) => {
            if (i) line.append(' · ');
            const el = document.createElement(changed ? 'b' : 'span');
            el.textContent = text;
            if (warn) el.className = 'team-mode-warn';
            line.append(el);
        });
    }
    const roleEl = row.querySelector('.team-agent-role-name');
    if (roleEl) roleEl.textContent = name;
    const summaryText = parts.map(p => p[0]).join(', ');
    row.querySelector('.team-agent-edit-btn')?.setAttribute('aria-label', `Edit ${name}`); // the row's one button; the summary is its description (aria-describedby)
}

/** The things that follow the list of members: each row's summary, the badge on the one that gets the first task, the Orchestrator's own limits, the buttons of the ends, the line above the list, and the gate. */
function _syncTeamMembers() {
    const rows = teamRows(), lead = leadRow();
    rows.forEach((row, i) => {
        _updateTeamAgentSummary(row);
        const orch = isOrchestrator(rowRole(row));
        const badge = row.querySelector('.team-agent-badge'); if (badge) badge.hidden = row !== lead;
        row.dataset.orchestrator = orch ? '1' : '';
    });
    const empty = document.querySelector('#team-panel-members .empty-state.empty-state-tight'); if (empty) empty.hidden = rows.length > 0;
    const count = document.getElementById('team-agents-count');
    if (count) count.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? 'member' : 'members'}. Select one to edit it.` : '';
    const line = document.getElementById('team-orchestrator-line'); if (line) line.hidden = hasOrchestrator();
    showTeamWorkers(rows.some(r => !isOrchestrator(rowRole(r))));
    _syncTeamGate();
}

let _teamStepPressed = false; // Next was pressed with step 1 wrong: only then does the line under the buttons name the first thing wrong (nothing is said before the first press)
let _membersPressed = false; // the same for step 2: Next was pressed with no Orchestrator

/** Why Launch team is off on the last step, in words and with the fix: a member's CLI that is missing or cannot run holds it (launch_dialog.js _syncTeamBlock), and that member's own warning is on the Members page, which this step does not show (#9945). tmux's line is above the buttons already. */
function _launchBlockReason() {
    const blocker = document.querySelector('#launch-step-team [data-blocks-launch]:not(#team-tmux-slot)');
    if (!blocker) return '';
    const what = (blocker.querySelector('span')?.textContent || '').trim().replace(/\.$/, '') || 'An agent CLI is missing';
    return /not found$/.test(what) ? `${what}: install it or set its path in Settings` : `${what}: set the right path in Settings`;
}

/** What is wrong on this step, in words, and Next (or Launch team) cannot go on; '' when it can. Steps 1 and 2 say it only after Next was pressed, and Next is never off there. */
function _teamGateReason() {
    const step = currentTeamStep();
    if (step === 'start') return _launchBlockReason();
    if (step === 'team') {
        if (!_teamStepPressed) return '';
        const name = (document.getElementById('team-board-name')?.value || '').trim(), dir = (document.getElementById('launch-team-dir')?.value || '').trim();
        if (!name) return 'Team name is required';
        if (boardNameProblem(name)) return 'Fix the team name to continue'; // the field above says what is wrong, once
        if (!dir) return 'Choose a folder for the team';
    } else if (step === 'members') {
        if (_membersPressed && !hasOrchestrator()) return 'Add an Orchestrator to continue';
    }
    return '';
}

/** The line above the buttons: the reason the next button is off, else (from step 2) the recap "<team>: N members, <folder>". Always in the page, only its text changes. */
function _syncTeamGate() {
    const step = currentTeamStep();
    const reason = _teamGateReason();
    const next = document.getElementById('launch-team-next'), go = document.getElementById('launch-team-go');
    const recap = document.getElementById('team-recap');
    for (const b of [next]) {
        if (!b) continue;
        if (reason && step !== 'team' && step !== 'members') { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-describedby', 'team-recap'); } else { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-describedby'); }
    }
    if (go && !go.disabled) go.removeAttribute('aria-disabled');
    if (!recap) return;
    recap.classList.toggle('launch-recap-warn', !!reason && step !== 'team' && step !== 'members');
    recap.classList.toggle('launch-recap-error', !!reason && (step === 'team' || step === 'members')); // steps 1 and 2: one red line naming the first thing wrong (step 1: the field errors are under the fields)
    recap.replaceChildren();
    if (reason) {
        recap.append(reason);
        const blocked = step === 'start' ? (document.querySelector('#launch-step-team [data-blocks-launch]:not(#team-tmux-slot)')?.textContent || '').trim().match(/^(claude|codex|agy|antigravity|gemini|pi)\b/i) : null; // a member's CLI blocks Launch team: the fix is one tap away, on this line (#10013)
        const setPath = blocked && cliPathButton(blocked[1].toLowerCase(), () => document.querySelectorAll('#launch-step-team [data-blocks-launch]:not(#team-tmux-slot) button:not(.cli-set-path)').forEach(b => b.click()), () => !!document.querySelector('#launch-step-team [data-blocks-launch]:not(#team-tmux-slot)')); // when Settings closes: every blocked member's own Check again (a team has one warning per member), again while it is still blocked
        if (setPath) recap.append(' ', setPath);
        return;
    }
    if (step === 'team') return;
    const name = (document.getElementById('team-board-name')?.value || '').trim(), dir = (document.getElementById('launch-team-dir')?.value || '').trim(), n = teamRows().length;
    const b = document.createElement('b'); b.textContent = name || 'unnamed';
    recap.append(b, `: ${n} ${n === 1 ? 'member' : 'members'}`);
    if (dir) { recap.append(', '); const d = document.createElement('b'); d.textContent = dir; recap.append(d); }
}
document.addEventListener('team-step-shown', _syncTeamGate);
document.addEventListener('cli-blocks-launch', e => { if (e.target.closest?.('#launch-step-team')) _syncTeamGate(); }); // a CLI check that answers while step 3 shows
document.addEventListener('team-page-open', e => { const page = e.target.closest && e.target.closest('.team-page'); if (page && page.dataset.page) showTeamStep(page.dataset.page); });
document.addEventListener('input', e => { if (e.target && (e.target.id === 'team-board-name' || e.target.id === 'launch-team-dir')) _syncTeamGate(); });

// Remove keeps the row aside for Undo (one removal back); a new removal, a template or a closed dialog makes the last one final.
let _removedTeamAgent = null;
function _clearTeamUndo() {
    _removedTeamAgent = null;
    const line = document.getElementById('team-undo');
    if (line) line.textContent = ''; // always in the page, only its text changes
}
function _removeTeamAgent(row) {
    if (!row) return;
    if (isOrchestrator(rowRole(row))) return; // the Orchestrator is not removed (#7407)
    const name = row.querySelector('.team-agent-role-name')?.textContent || 'Member';
    _removedTeamAgent = { row, next: row.nextElementSibling, list: row.parentElement };
    row.remove();
    _syncTeamMembers();
    const line = document.getElementById('team-undo');
    if (!line) return;
    line.textContent = '';
    line.append(`Removed ${name}. `);
    const undo = document.createElement('button');
    undo.type = 'button'; undo.className = 'btn-link'; undo.setAttribute('data-on-click', 'team-agent-undo'); undo.textContent = 'Undo';
    line.append(undo);
    document.querySelector('#launch-step-team .team-add-agent-btn')?.focus(); // the row the focus was in is gone
}
function _undoTeamAgentRemoval() {
    const r = _removedTeamAgent;
    if (!r) return;
    r.list.insertBefore(r.row, r.next && r.next.parentElement === r.list ? r.next : null);
    _clearTeamUndo();
    _syncTeamMembers();
    r.row.querySelector('.team-agent-edit-btn')?.focus();
}

// Next needs what this step needs; on a step that is not met, it says so where the person looks (the field, or the line that says what is missing) and does not go on.
function teamStepMove(dir) {
    const step = currentTeamStep();
    const i = TEAM_STEPS.indexOf(step);
    if (dir > 0 && step === 'team') {
        if (!teamForm().validate({ focus: true }).ok) { _teamStepPressed = true; _syncTeamGate(); return; } // the first field that is wrong takes the focus and says what is missing
    }
    if (dir > 0 && step === 'members' && !hasOrchestrator()) { _membersPressed = true; document.getElementById('team-add-orchestrator')?.focus(); _syncTeamGate(); return; } // the button that fixes it takes the focus, and the one red line says what is missing
    const to = TEAM_STEPS[Math.min(TEAM_STEPS.length - 1, Math.max(0, i + dir))];
    if (to === 'members') _syncTeamMembers();
    showTeamStep(to, { focus: true });
}

const _teamModeFlags = agentType => _getPermissionFlagsForAgentMode(agentType || document.getElementById('team-agent-type')?.value || 'claude', document.getElementById('team-permission-mode')?.value || 'default');

function _defaultTeamAgentModalConfig() {
    const agentType = document.getElementById('team-agent-type')?.value || '';
    return {
        name: '',
        prompt: '',
        agentType,
        model: '',
        capabilities: null,
        flags: _teamModeFlags(agentType), // a new member starts at the saved default Mode, not Auto (#6412)
    };
}

// Add member / Edit member (#7861, the operator's "same flow as New Agent"): the agent step of the Launch dialog in a second mode, over the team form. The member's values are loaded (a new one
// starts at the team's provider and default Mode), its role and prompt are the persona step, Save member (not Launch) writes it into the team form and launches nothing; its changes are held until
// Save member, and Cancel, the arrow and Escape return to the team form without them. The dialog code is New Agent's (launch_dialog.js _selectLaunchType, _applyMember).
function showTeamAgentModal(row = null, { role = '' } = {}) {
    const acfValue = row?.dataset.acfId ? getAgentConfig(row.dataset.acfId) : { ..._defaultTeamAgentModalConfig(), name: role };
    // A member with no Mode of its own launches with the saved default Mode: the dialog shows that Mode (saving it unchanged keeps the member following it, see saveTeamAgentFromModal).
    if (row && !/--permission-mode|--mode|--sandbox|--full-auto|--dangerously/.test(acfValue.flags || '')) acfValue.flags = [acfValue.flags, _teamModeFlags(acfValue.agentType)].filter(Boolean).join(' ');
    const dialog = document.getElementById('launch-modal');
    if (dialog && getComputedStyle(dialog).display === 'none') { dialog.style.display = 'flex'; launch.mode = 'team'; _showLaunchStep('team'); } // display-ok: the member is a step of the Launch dialog, which is open when a person is in the team form; opened as it is when something else asks (the team form is kept, not reset)
    launch.member = { row, returnTo: currentTeamStep(), value: acfValue };
    window._selectLaunchType('agent');
    _syncMemberMoveButtons();
}
window.showTeamAgentModal = showTeamAgentModal;

/** Back to the team form from a member: its step, the Launch dialog's team panels (the member's changes, if any, are saved by the caller first). */
function _leaveMember() {
    const back = launch.member?.returnTo || 'members';
    launch.member = null;
    launch.mode = 'team';
    document.getElementById('launch-modal')?.removeAttribute('data-member');
    _showLaunchStep('team');
    showTeamStep(back);
}

/** Remove from team, in the Edit member dialog (#10836): back to the team form, then the member is removed aside for Undo as before. The Orchestrator is not removed. */
function _removeMemberFromDialog() {
    const row = launch.member?.row;
    if (!row || isOrchestrator(rowRole(row))) return;
    _leaveMember();
    _removeTeamAgent(row);
}

function cancelTeamMember() {
    const row = launch.member?.row;
    _leaveMember();
    (row?.querySelector('.team-agent-edit-btn') || document.querySelector('#launch-step-team .team-add-agent-btn'))?.focus();
}
window.cancelTeamMember = cancelTeamMember;

function saveTeamAgentFromModal() {
    const m = launch.member;
    if (!m) return;
    const config = getAgentConfig('launch-agent-acf');
    config.name = (document.getElementById('launch-agent-name-input')?.value || '').trim() || config.name; // the role is the persona step's name field
    if (!config.name) {
        window._launchStage?.('persona');
        agentNameForm().validate({ focus: true }); // the role is flagged under its field, and one red line above the buttons says it
        agentStatus('A member needs a role');
        return;
    }

    // The Mode left at the default is not the member's own: it keeps following the saved default, which the launch needs (an own Mode beats it, #6440).
    const modalMode = document.querySelector('#launch-agent-acf .acf-permission-mode')?.value;
    if (modalMode && modalMode === (document.getElementById('team-permission-mode')?.value || 'default')) config.flags = _normalizePermFlagsForAgent(config.flags, config.agentType, 'default');
    const followsType = config.agentType === document.getElementById('team-agent-type')?.value; // a provider left at the default keeps following it
    const opener = m.row;
    if (opener?.dataset.acfId) {
        opener.dataset.followsTeamType = followsType ? '1' : '';
        setAgentConfig(opener.dataset.acfId, config);
    } else {
        _addTeamAgent(config.name, config.prompt, config.capabilities, followsType ? '' : config.agentType, config.model, config.flags, { reveal: true });
    }
    _leaveMember();
    _syncTeamMembers(); // a rename can make or lose the Orchestrator
    (opener || document.querySelector('#team-agents-list .team-agent-row:last-child'))?.querySelector('.team-agent-edit-btn')?.focus();
}
window.saveTeamAgentFromModal = saveTeamAgentFromModal;

// ── Agent Team ────────────────────────────────────────────────────────────


/** Apply a preset to a specific AgentConfigForm by container ID */
function _applyACFPresetFor(containerId, name) {
    const persona = name ? _findPersona(name) : null;
    const current = getAgentConfig(containerId);
    if (persona) {
        setAgentConfig(containerId, {
            name: persona.name,
            prompt: persona.prompt,
            flags: persona.flags || current.flags,
            agentType: persona.agentType || persona.agent_type || current.agentType,
            model: persona.model || current.model,
            capabilities: persona.capabilities,
        });
    } else {
        setAgentConfig(containerId, {
            agentType: _settingsFor(_acfServer(document.getElementById(containerId))).default_agent_type || current.agentType,
        });
    }
}

// Default team: first 3 presets

/** Worktree option is offered when the working directory is a git repo ON THE TARGET SERVER. */
async function _checkTeamGitDir() {
    const server = _effectiveServer(launch.server);
    const dirInput = document.getElementById("launch-team-dir");
    const dir = dirInput ? dirInput.value.trim() : '';
    if (!dir || !teamForm()) return;
    try {
        const resp = await serverFetch(server, `/api/filesystem/is-git?path=${encodeURIComponent(dir)}`);
        const data = await resp.json();
        if (server !== _effectiveServer(launch.server)) return;
        showTeamWorktree(!!data.is_git);
        // Base Branch starts as the repo's own current branch (the answer's `branch`), not a guess ("main" in a repo that has master, #6707), until the person types one.
        const base = document.getElementById('launch-team-base-branch');
        if (base && data.is_git && typeof data.branch === 'string' && data.branch && base.dataset.edited !== '1') base.value = data.branch;
    } catch { showTeamWorktree(false); }
}

/** The target server's board names and labels, to say before launching that one exists (#3536). */
async function _loadExistingTeamBoards() {
    const server = _effectiveServer(launch.server);
    launch.existingTeamBoardNames = new Set();
    try {
        const resp = await serverFetch(server, "/api/board/projects");
        const projects = await resp.json();
        if (server !== _effectiveServer(launch.server) || !Array.isArray(projects)) return;
        for (const p of projects) {
            if (p.project) launch.existingTeamBoardNames.add(String(p.project).trim().toLowerCase());
            if (p.board_label) launch.existingTeamBoardNames.add(String(p.board_label).trim().toLowerCase());
        }
    } catch (_) {}
    _validateTeamName();
}

// The team form starts at the CLI's own confirm mode (Default), not Auto: the person's saved default wins, and a mode they pick stays (#6397).
function _applyTeamDefaultMode() {
    const el = document.getElementById('team-permission-mode');
    if (!el) return;
    trackPermissionPick(el);
    if (!el.dataset.pickedByPerson) el.value = _settingsFor(_effectiveServer(launch.server)).default_permission_mode || 'default';
    _updatePermModeDescription(el);
}

/** The last three folders as buttons under the folder field (a repeat launch is one click), with the "Recent:" label (#7407). */
function _renderTeamDirRecents() {
    const box = document.getElementById('launch-team-dir-recents');
    if (!box) return;
    const dirs = getRecentDirs(_effectiveServer(launch.server)).slice(0, 3);
    box.replaceChildren(...(dirs.length ? [Object.assign(document.createElement('span'), { className: 'launch-recent-label', textContent: 'Recent:' })] : []), ...dirs.map(d => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-small launch-dir-recent'; b.title = d; b.dataset.dir = d; b.dataset.team = '1'; b.setAttribute('data-on-click', 'launch-dir-recent');
        b.textContent = d.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || d;
        return b;
    }));
}

async function _initTeamForm() {
    // Hide generated-team banner on normal opens
    const banner = document.getElementById('generated-team-banner');
    if (banner) banner.style.display = 'none';

    // Reset form
    document.getElementById("team-board-name").value = "";
    const addr = document.getElementById("team-board-server");
    if (addr) { addr.value = ""; addr.disabled = true; } // the machine's own entry reveals it (launch_dialog.js _syncTeamAddress)
    launch.existingTeamBoardNames = new Set();
    _teamStepPressed = false; _membersPressed = false;
    teamForm()?.clearErrors();
    _validateTeamName();
    const tapEl = document.getElementById("team-permission-mode");
    if (tapEl) {
        delete tapEl.dataset.pickedByPerson; // a new dialog: the default again, for the agent type the team starts with (#5836)
        const teamSettings = _settingsFor(_effectiveServer(launch.server));
        _applyTeamDefaultMode();
    }
    launch.teamAgentCounter = 0;
    const list = document.getElementById("team-agents-list");
    list.innerHTML = "";
    _clearTeamUndo();
    mountTeamLaunchSettings(); // step 3's tabs, with a new team's own settings
    showTeamStep('team');
    _applyTeamDefaultMode();

    // Pre-fill working dir from the target server's settings
    const s = _settingsFor(_effectiveServer(launch.server));
    const dirInput = document.getElementById("launch-team-dir");
    // No folder is chosen for the person (#5989): the Settings default if they set one, else empty and required, never the home folder.
    if (dirInput) dirInput.value = '';
    const goalEl = document.getElementById("team-goal");
    if (goalEl) goalEl.value = "";
    if (launch.server !== LOCAL_SERVER) _resetDirInputs(['launch-team-dir'], launch.server, s, { switching: true });
    else if (s.default_working_dir && dirInput) dirInput.value = s.default_working_dir;

    // Show worktree option when directory is a git repo (checked on the target server)
    if (dirInput && !dirInput.dataset.gitWired) {
        dirInput.dataset.gitWired = '1';
        let _gitCheckTimer;
        dirInput.addEventListener('input', () => { clearTimeout(_gitCheckTimer); _gitCheckTimer = setTimeout(_checkTeamGitDir, 500); });
        dirInput.addEventListener('change', _checkTeamGitDir);
    }
    for (const id of ['team-board-name', 'launch-team-dir']) { // Enter in either is Next (#7407)
        const el = document.getElementById(id);
        if (el && !el.dataset.enterWired) { el.dataset.enterWired = '1'; el.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && currentTeamStep() === 'team') { e.preventDefault(); teamStepMove(1); } }); }
    }
    document.getElementById('launch-team-base-branch')?.addEventListener('input', e => { e.target.dataset.edited = '1'; }); // a branch the person typed is kept when the folder changes
    _checkTeamGitDir(); // initial check
    _renderTeamDirRecents();
    const typeSelect = document.getElementById("team-agent-type");
    if (s.default_agent_type && typeSelect) typeSelect.value = s.default_agent_type;
    if (typeSelect) {
        typeSelect.onchange = () => {
            _followTeamType(); // the members with no provider of their own take the team's (#6440)
            _applyTeamDefaultMode(); // still the default: it follows the saved setting (#5836)
            _syncTeamMembers();
            const tfEl = document.getElementById("team-flags");
            if (tfEl) {
                const modeEl = document.getElementById("team-permission-mode");
                const mode = modeEl?.value || 'default';
                tfEl.value = _normalizePermFlagsForAgent(tfEl.value, typeSelect.value, mode);
            }
        };
    }

    // The default team is in Members when the dialog opens (#9877, the Operator): the Orchestrator, the Lead Developer and the QA Engineer, the first three of the Coding Team, each removable; a template still replaces them.
    // A team the AI generated fills the list itself (launch.skipDefaultTeamAgents). #5989 opened it empty after four agents nobody picked were launched; three a person can see and remove are not that.
    const defaultsOnOpen = !launch.skipDefaultTeamAgents;
    if (defaultsOnOpen) { _addDefaultMembers(); resetTeamTemplatePicker(); markTeamTemplate(DEFAULT_TEAM_KEY); } // marked now, not after the board names load: a pick made meanwhile must not be overwritten

    // Fetch existing boards for uniqueness validation
    await _loadExistingTeamBoards();

    // The template picker says what is in Members: the default team when it was filled in, nothing chosen otherwise (#9906)
    // An AI-generated team fills Members and marks the picker itself, before this async step resumes: the reset must not take its mark away (#9911).
    _syncTeamMembers();

    launch.skipDefaultTeamAgents = false;

    // (no focus into the team name here: it sits in Board & workspace, which is not the section the dialog opens on, and focusing it would scroll that pane; section_dialog.js puts the keyboard in the list)
    _validateTeamName();
}


/** The default team's members: the first three of the Coding Team (#9877). */
function _addDefaultMembers() {
    for (const a of BUILTIN_TEAM_TEMPLATES[0].agents.slice(0, 3)) _addTeamAgent(a.name, a.prompt, a.capabilities, a.agent_type, a.model, a.flags);
}

function _loadTeamTemplate(name) {
    const all = [...BUILTIN_TEAM_TEMPLATES, ..._getSavedTeamTemplates()];
    const tmpl = all.find(t => t.name === name);
    if (!tmpl) { console.warn('[coral] Template not found:', name); return; }

    // Clear current agents and load from template
    launch.teamAgentCounter = 0;
    document.getElementById("team-agents-list").innerHTML = "";
    _clearTeamUndo();

    for (const agent of tmpl.agents) {
        const agentName = agent.name || agent.role || '';
        const agentPrompt = agent.prompt || agent.description || '';
        _addTeamAgent(agentName, agentPrompt, agent.capabilities, agent.agent_type, agent.model, agent.flags);
    }
    if (tmpl.flags) {
        const tfEl = document.getElementById("team-flags");
        if (tfEl) { tfEl.value = tmpl.flags; _syncFlagButtons("team-flags"); }
    }
    setTeamLaunchMode(tmpl.mode || 'none'); // the template's working mode, None when it names none (the built-in Coding Team starts with Task queue, #8919)
    markTeamTemplate(name);
    _syncTeamMembers();
}

// reveal: scroll the new row into view. Only for a member the person added; the default members and a template's are added while the dialog opens or fills, and scrolling to the last of them
// left the Members step opened past its heading and the template picker (#4950). top: put the row first (Add Orchestrator).
function _addTeamAgent(defaultName, defaultPrompt, defaultCapabilities, defaultAgentType, defaultModel, defaultFlags, { reveal = false, top = false } = {}) {
    launch.teamAgentCounter++;
    const idx = launch.teamAgentCounter;
    const acfId = `team-agent-acf-${idx}`;
    const sumId = `team-agent-summary-${idx}`;
    const list = document.getElementById("team-agents-list");
    const row = document.createElement("div");
    row.className = "team-agent-row";
    row.setAttribute('role', 'listitem');
    row.draggable = true;
    row.dataset.idx = idx;
    row.dataset.acfId = acfId;
    if (!defaultAgentType) row.dataset.followsTeamType = '1';

    // A member is one quiet row, read-only: its role and one summary line. The row opens the Edit member dialog, and so does the one Edit button at its end (Remove is in that dialog; Alt+Up/Down on the row's button reorders, as dragging does, #10836). The form that holds the member's values is kept (hidden) in the row.
    row.innerHTML = `
        <div class="team-agent-open">
            <span class="team-agent-main"><span class="team-agent-role-name">${escapeHtml(defaultName || 'New member')}</span><span class="chip team-agent-badge" hidden>Gets the first task</span></span>
            <span class="team-agent-summary" id="${escapeAttr(sumId)}"></span>
        </div>
        <button type="button" class="btn team-agent-edit-btn" data-on-click="team-agent-edit" aria-describedby="${escapeAttr(sumId)}">Edit</button>
        <div class="team-agent-form" hidden><div id="${escapeAttr(acfId)}"></div></div>
    `;
    if (top) list.prepend(row); else list.appendChild(row);

    // Render ACF inside the row (hidden: it holds the member's values)
    const caps = defaultCapabilities || _findPersona(defaultName)?.capabilities || null;
    const acfValue = {
        name: defaultName || '',
        prompt: defaultPrompt || '',
        agentType: defaultAgentType || document.getElementById('team-agent-type')?.value || '',
        model: defaultModel || '',
        capabilities: caps,
    };
    acfValue.flags = defaultFlags || ''; // a member with no mode of its own starts at Default and follows the saved default Mode (#6397)
    renderAgentConfigForm(acfId, {
        showPreset: false,
        showName: true,
        showAutoPermissions: true,
        value: acfValue,
    });

    // The row's text opens Edit member for a click; a keyboard has the Edit button for the same (so no tab stop of its own)
    row.addEventListener('click', (e) => { if (e.target.closest('.team-agent-open')) window.showTeamAgentModal(row); });

    // A keyboard way to reorder besides dragging (WCAG 2.5.7, #10836): Alt+ArrowUp / Alt+ArrowDown on the row's button
    row.addEventListener('keydown', (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        _moveTeamAgent(row, e.key === 'ArrowUp' ? -1 : 1, { say: true });
    });

    // Drag-and-drop reorder handlers
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', idx.toString());
        row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        list.querySelectorAll('.team-agent-row.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
    });
    row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedIdx = e.dataTransfer.getData('text/plain');
        const draggedRow = list.querySelector(`.team-agent-row[data-idx="${draggedIdx}"]`);
        if (draggedRow && draggedRow !== row) {
            const rows = [...list.children];
            const fromPos = rows.indexOf(draggedRow);
            const toPos = rows.indexOf(row);
            if (fromPos < toPos) {
                list.insertBefore(draggedRow, row.nextSibling);
            } else {
                list.insertBefore(draggedRow, row);
            }
            _syncTeamMembers();
        }
    });

    _syncTeamMembers();
    if (reveal) row.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    return row;
}

// Move a member up or down (Alt+Arrow on its row, #10836); said politely: "Moved QA Engineer to 2 of 5". The Orchestrator does not move up (#7407).
function _moveTeamAgent(rowOrBtn, direction, { say = false, focus = true, liveId = 'team-agents-live' } = {}) {
    const row = rowOrBtn.closest?.('.team-agent-row');
    if (!row) return;
    const list = row.parentElement;
    if (direction === -1 && row.previousElementSibling && !isOrchestrator(rowRole(row))) {
        list.insertBefore(row, row.previousElementSibling);
    } else if (direction === 1 && row.nextElementSibling) {
        list.insertBefore(row.nextElementSibling, row);
    } else return;
    _syncTeamMembers();
    if (focus) row.querySelector('.team-agent-edit-btn')?.focus();
    const live = document.getElementById(liveId);
    if (say && live) { const rows = teamRows(); live.textContent = `Moved ${rowRole(row) || 'member'} to ${rows.indexOf(row) + 1} of ${rows.length}`; }
}

/** Move up / Move down in the Edit member dialog (#10868): the same move as Alt+Arrow, for a touch-only person; the dialog stays open so it can be pressed again, and it is said as "Moved X to N of M". */
function _syncMemberMoveButtons() {
    const row = launch.member?.row, up = document.getElementById('launch-agent-move-up'), down = document.getElementById('launch-agent-move-down');
    if (!row || !up || !down) return;
    const rows = teamRows(), i = rows.indexOf(row);
    up.disabled = i <= 0 || isOrchestrator(rowRole(row)); // the Orchestrator does not move up (#7407)
    down.disabled = i < 0 || i === rows.length - 1;
}
function _moveMemberFromDialog(direction) {
    const row = launch.member?.row;
    if (!row) return;
    _moveTeamAgent(row, direction, { say: true, focus: false, liveId: 'launch-stage-live' });
    _syncMemberMoveButtons();
    const a = document.activeElement;
    if (a && a.disabled) document.getElementById(direction === -1 ? 'launch-agent-move-down' : 'launch-agent-move-up')?.focus(); // the button that was pressed is off at the end: the other one takes the focus
}

window._addTeamAgent = (name, prompt) => {
    _addTeamAgent(name || "", prompt || "");
};

/** Add an Orchestrator at the top of the list (#7407): it gets the first task. Nothing is added unasked: each member starts a CLI process. */
function _addOrchestrator() {
    if (hasOrchestrator()) return;
    const prompt = _findPersona('Orchestrator')?.prompt || BUILTIN_TEAM_TEMPLATES[0].agents.find(a => a.name === 'Orchestrator')?.prompt || '';
    const row = _addTeamAgent('Orchestrator', prompt, null, '', '', '', { reveal: true, top: true });
    row?.querySelector('.team-agent-edit-btn')?.focus();
}

/** The template select: Blank team clears the members, a template replaces them (as loading a template always did). */
function _pickTeamTemplate(name) {
    if (!name) {
        launch.teamAgentCounter = 0;
        document.getElementById('team-agents-list').innerHTML = '';
        _clearTeamUndo();
        markTeamTemplate('');
        _syncTeamMembers();
        return;
    }
    if (name === GENERATED_TEAM_KEY) return; // the members are already the generated team: choosing what is chosen changes nothing
    if (name === DEFAULT_TEAM_KEY) { // the default team again: it replaces the members, as any template does
        launch.teamAgentCounter = 0;
        document.getElementById('team-agents-list').innerHTML = '';
        _clearTeamUndo();
        _addDefaultMembers();
        markTeamTemplate(DEFAULT_TEAM_KEY);
        _syncTeamMembers();
        return;
    }
    _loadTeamTemplate(name);
}

/** Set all workers to a provider (#7407): every member whose role is not the Orchestrator takes it, and their Model and Thinking go back to the provider's defaults; Mode, role and prompt stay. */
function _setAllWorkers(type) {
    const sel = document.getElementById('team-set-all');
    if (!type) return;
    let n = 0;
    for (const row of teamRows()) {
        if (isOrchestrator(rowRole(row))) continue;
        row.dataset.followsTeamType = '';
        resetProviderChoices(row.dataset.acfId, type);
        n++;
    }
    if (sel) sel.value = '';
    const label = [...(document.getElementById('team-agent-type')?.options || [])].find(o => o.value === type)?.textContent.replace(/ \(.*\)$/, '') || type;
    _clearTeamUndo();
    const line = document.getElementById('team-undo');
    if (line) line.textContent = `Set ${n} ${n === 1 ? 'worker' : 'workers'} to ${label}.`;
    _syncTeamMembers();
}

function _validateTeamName() {
    const input = document.getElementById("team-board-name");
    const hint = document.getElementById("team-board-name-hint");
    const form = teamForm();
    if (!input || !hint || !form) return true;
    const value = input.value.trim();
    hint.textContent = "";
    if (!value) { form.error('name', ''); return false; }
    const problem = boardNameProblem(value); // a bad name is flagged on its field (aria-invalid), which marks its section in the list while the person is elsewhere
    form.error('name', problem);
    if (problem) return false;
    // A name in use is allowed (#3536): launching asks whether to join that board or start another.
    if (launch.existingTeamBoardNames.has(value.toLowerCase())) hint.textContent = "A team with this name exists. Launching asks whether to join it or start another.";
    return true;
}
window._validateTeamName = _validateTeamName;

async function launchTeam() {
    const boardName = document.getElementById("team-board-name").value.trim();
    if (!boardName) {
        showToast("Team name is required", true);
        showTeamStep('team'); teamForm().validate({ focus: true });
        return;
    }
    if (!_validateTeamName()) {
        const problem = boardNameProblem(boardName) || "Team name must be unique";
        showToast(problem, true);
        showTeamStep('team'); markFieldInvalid(document.getElementById("team-board-name"), problem);
        return;
    }

    const workingDir = document.getElementById("launch-team-dir").value.trim();
    if (!workingDir) {
        showTeamStep('team'); markFieldInvalid(document.getElementById("launch-team-dir"), "Choose a folder for the team");
        return;
    }

    if (document.querySelector('#launch-step-team [data-blocks-launch]')) return; // tmux is missing: the line above Launch Team says so (#6046)
    const server = _effectiveServer(launch.server);
    if (_launchBlocked(server)) return;
    const agentType = document.getElementById("team-agent-type").value;
    const teamPermMode = document.getElementById("team-permission-mode")?.value || 'default';

    // Build agent-native flags from the permission mode dropdown.
    const flags = _getPermissionFlagsForAgentMode(agentType, teamPermMode).split(/\s+/).filter(Boolean);

    // Collect agent definitions
    const rows = document.querySelectorAll("#team-agents-list .team-agent-row");
    const members = () => showTeamStep('members'); // the problem is in Members: open it
    if (rows.length === 0 || !hasOrchestrator()) {
        showToast("Add an Orchestrator", true);
        members(); _syncTeamGate();
        return;
    }

    const agents = [];
    for (const row of rows) {
        const acfId = row.dataset.acfId;
        const config = acfId ? getAgentConfig(acfId) : {};
        if (!config.name) {
            showToast("Each member needs a role", true);
            members();
            return;
        }
        const agent = { name: config.name, prompt: config.prompt };
        const icon = row.querySelector(".team-agent-icon")?.value.trim() || "";
        if (icon) agent.icon = icon;
        if (config.capabilities) agent.capabilities = config.capabilities;
        if (config.agentType) agent.agent_type = config.agentType;
        if (config.model) agent.model = config.model;
        if (config.thinking) agent.thinking = config.thinking; // #4969
        if (config.flags) agent.flags = config.flags.split(/\s+/).filter(Boolean);
        // A member whose mode is Default says so (#10362): its form sends no flag for Default, the same request as "nothing chosen", which starts in the saved default or Auto.
        if (config.permissionMode === 'default' && !(config.flags && _hasPermFlag(config.flags))) agent.permission_mode = 'default';
        agents.push(agent);
    }

    const settings = readTeamLaunchSettings(); // step 3's tabs (#7407)
    if (settings.problem) { // the form has opened its tab and focused the field
        showTeamStep('start');
        showToast(settings.problem.text, true);
        return;
    }
    const goal = document.getElementById("team-goal")?.value.trim() || "";
    const boardServer = document.getElementById("team-board-server").value.trim();
    const useWorktree = document.getElementById("launch-team-worktree")?.checked;
    const baseBranch = document.getElementById("launch-team-base-branch")?.value.trim();

    const payload = {
        board_name: boardName,
        working_dir: workingDir,
        agent_type: agentType,
        flags,
        agents,
    };
    if (boardServer) payload.board_server = boardServer;
    if (settings.working_mode) payload.working_mode = settings.working_mode; // the working mode, its guidance and the Additional instructions (#7407)
    if (settings.health_monitor) payload.health_monitor = true;
    if (useWorktree) {
        payload.worktree = true;
        if (baseBranch) payload.base_branch = baseBranch;
    }

    // Disable launch button to prevent double-clicks
    const launchBtn = document.getElementById('launch-team-go');
    if (launchBtn) { launchBtn.disabled = true; launchBtn.textContent = 'Launching\u2026'; }

    try {
        const result = await _launchOn(server, "/api/sessions/launch-team", payload, undefined, { teamFailures: true, fields: { base_branch: document.getElementById('launch-team-base-branch') } });
        if (result) {
            if (result.ok !== false) recordRecentDir(workingDir, server); // not for a team in which nobody started (#122)
            // Check for per-agent errors in the launched array
            const launched = result.agents || result.launched || [];
            const failed = launched.filter(a => a.error);
            if (failed.length > 0) showTeamLaunchFailures(failed, launched.length - failed.length, showSettingsModal);
            if (launched.length - failed.length > 0) {
                const wtNote = result.worktree_path ? ` in worktree ${result.worktree_path}` : '';
                showToast(`Launched team: ${launched.length - failed.length} agents on "${boardName}"${_onServerSuffix(server)}${wtNote}`);
            }
            // A team in which nobody started (the server answered an error, #122): the dialog stays open, to fix the setup and launch again.
            if (result.ok !== false) {
                hideLaunchModal();
                if (launched.length - failed.length > 0) importOnce('./alerts_offer.js').then(m => m.offerAlertsAfterLaunch()).catch(() => {}); // the first agents are when alerts make sense: once per browser (#10068)
                setTimeout(loadLiveSessions, 2000);
                const boardId = result.board_id || boardName; // the id the server made (a repeated name gets its own, "Create another"), not the label that was typed
                const seen = _refreshAfterLaunch(server, { boardName: boardId });
                // The team opens the way a single agent does (#5989): its board with the Team view beside it, and the goal, if one was typed, as the Operator's first message to the lead. On a remote this waits for the hub to see the team.
                if (launched.length - failed.length > 0) _openLaunchedTeam(server, boardId, goal, agents, seen, settings.board, settings.save_goal);
            }
        }
    } catch (e) {
        showToast("Failed to launch team", true);
    } finally {
        if (launchBtn) { launchBtn.disabled = false; launchBtn.textContent = 'Launch team'; }
    }
}
/** A first task's title: its first sentence (up to 80 characters), else its first 60 characters cut at a word with an ellipsis; the whole text is the body (#10279, Beta #10325). */
function firstTaskTitle(text) {
    const flat = String(text || '').trim().replace(/\s+/g, ' ');
    const sentence = /^.*?[.!?](?=\s|$)/.exec(flat);
    if (sentence && sentence[0].length <= 80) return sentence[0];
    if (flat.length <= 80) return flat;
    const cut = flat.slice(0, 60), at = cut.lastIndexOf(' ');
    return (at > 30 ? cut.slice(0, at) : cut).replace(/[\s.,;:!?-]+$/, '') + '\u2026';
}

/** The first task as a task of the team, assigned to its lead (titled by its first sentence, the whole text the body), and, when asked, the team's goal with the task under it. A refusal is said in a toast and the board line still goes (#10007, #10279). */
async function addFirstTask(key, lead, goal, saveGoal = false) {
    const title = firstTaskTitle(goal);
    let goalId = null;
    if (saveGoal) { // the first task is also the team's goal, and the task is listed under it (#10279)
        try {
            const g = await boardFetch(key, '/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, ...(goal !== title ? { outcome: goal } : {}), subscriber_id: OPERATOR_ID }),
            });
            if (!g.ok) throw new Error(String(g.status));
            goalId = Number((await g.json()).id) || null;
            if (goalId) showToast("Your first task is saved as the team's goal: it is on the Goals tab."); // the Goals 1 that appears says where it came from (#10532)
        } catch { showToast('The team started, but its goal was not saved. Add it on the Goals tab.', true); }
    }
    try {
        const r = await boardFetch(key, '/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, body: goal, assigned_to: lead, created_by: 'Operator', ...(goalId ? { goal_id: goalId } : {}) }),
        });
        if (!r.ok) throw new Error(String(r.status));
    } catch { showToast('The team started, but the first task was not added to its Tasks tab.', true); }
}
/** Open the launched team, and post the goal to its lead: the agent named Orchestrator, else the first member. The goal that could not be sent is left in the message box of the team page's Messages tab with a toast, to send again without launching the team twice. */
async function _openLaunchedTeam(server, boardName, goal, agents, seen, boardSettings = null, saveGoal = false) {
    const key = identityKey(server, boardName);
    const lead = (agents.find(a => isOrchestrator(a.name)) || agents[0]).name;
    const content = goal ? `@${lead} ${goal}` : '';
    let sent = !goal;
    try {
        await seen; // on a remote, until the hub lists the team (or the wait runs out: the post and the open are still tried)
        const unsaved = await applyTeamBoardSettings(key, boardSettings); // Require a goal, the health check's rules and the messaging switches, held until the board existed (#7407)
        if (unsaved) showToast(unsaved, true, undefined, { action: { label: 'Open Team settings', onClick: () => window.showTeamWorkingModeWorkspace?.(key) } });
        if (goal) {
            await addFirstTask(key, lead, goal, saveGoal); // the request is work on the Tasks tab as well as a line on the board (#10007)
            const r = await boardFetch(key, '/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content }),
            });
            sent = r.ok;
        }
    } catch { sent = false; }
    try {
        await loadLiveSessions();
        const { openTeamPage } = await importOnce('./team_page.js');
        await openTeamPage(key, { tab: 'messages' }); // the team opens on its board, where the first task was sent (or waits to be)
    } catch { /* the toast and the row are still there */ }
    const input = document.getElementById('mb-post-input');
    if (!sent) {
        if (input && !input.value) { input.value = content; input.dispatchEvent(new Event('input', { bubbles: true })); }
        showToast('The team started, but the first task was not sent. It is in the message box: press Send to try again.', true);
    }
    // A mouse: the box, where the person types next, with a first task sent or not (a launch left the keyboard on the page's body, Beta #10401). A touch screen: the page's heading, not the box, whose focus raises the on-screen keyboard over a page nobody has looked at yet (#10281, as the password dialog's close, #10067).
    const heading = window.matchMedia?.('(pointer: coarse)').matches || isPhoneLayout() ? document.getElementById('team-page-title') : null; // the phone layout counts as a phone whether or not the browser says coarse (#10589)
    (heading || input)?.focus({ preventScroll: !!heading });
}
window.launchTeam = launchTeam;

export { _openLaunchedTeam, _addTeamAgent, _applyACFPresetFor, _checkTeamGitDir, _initTeamForm, _loadExistingTeamBoards, _moveTeamAgent, _removeMemberFromDialog, _moveMemberFromDialog, _renderTeamTemplateSelector, _syncTemplateMenu, _removeTeamAgent, _undoTeamAgentRemoval, _syncTeamMembers, _pickTeamTemplate, _setAllWorkers, _addOrchestrator, teamStepMove };
