/* The AI team wizard (moved out of team_dialogs.js as it was, #5174; no behaviour change): the dialog, the generate job and its poll, and the generated draft handed to the Agent Team form. */
import { importOnce } from './import_once.js';
import { closeOnBackdropAndEscape, releaseEscape } from './dialog_close.js';
import { showToast } from './utils.js';
import { pollEvery } from './overload.js';
const { launch } = await importOnce('./launch_state.js');
const { _showLaunchStep } = await importOnce('./launch_core.js');
const { _syncFlagButtons } = await importOnce('./flag_shortcuts.js');
const { _initTeamForm, _addTeamAgent } = await importOnce('./team_dialogs.js');
const { markGeneratedTeam } = await importOnce('./team_templates_ui.js');
const { showTeamStep } = await importOnce('./team_steps.js');

function _setTeamWizardError(message = '') {
    const errorEl = document.getElementById('team-wizard-error');
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('team-wizard-error-quiet', !message); // the room stays: the buttons below do not move when it fills (#10517)
}

/** "1 member" / "3 members": a team's agents are its members everywhere else in the New team flow (#10314). */
const _membersWords = n => `${n} member${n === 1 ? '' : 's'}`;

/** What went wrong in words that end with what to do next (#10314): a draft with no members says what to ask for; any other failure says to try again or use a template. */
function _plainGenerateError(message) {
    const m = String(message || '');
    if (/no agents|any agents|empty response/i.test(m)) return 'The draft had no members. Try again and name the roles you want, for example "an orchestrator, a developer and a tester".';
    return /try again|pick a template/i.test(m) ? m : `${m.replace(/\s*\.?$/, '.')} Try again, or pick a template instead.`;
}

function showTeamWizardModal() {
    const modal = document.getElementById('team-wizard-modal');
    if (!modal) return;

    const directiveEl = document.getElementById('team-wizard-directive');
    const generateBtn = document.getElementById('team-wizard-generate-btn');

    // If a job is actively running, show generating state
    if (_activeGenerateJobId) {
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
            generateBtn.style.display = '';
        }
    } else {
        _setTeamWizardError('');
        if (directiveEl) directiveEl.value = '';
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate team';
            generateBtn.style.display = '';
        }
    }
    modal.style.display = 'flex';
    if (!_activeGenerateJobId) directiveEl?.focus();

    // Close on backdrop click and on Escape
    closeOnBackdropAndEscape(modal, hideTeamWizardModal);
}
window.showTeamWizardModal = showTeamWizardModal;

function hideTeamWizardModal() {
    const modal = document.getElementById('team-wizard-modal');
    if (!modal) return;
    modal.style.display = 'none';
    _setTeamWizardError('');
    releaseEscape(modal);
}
window.hideTeamWizardModal = hideTeamWizardModal;

function _normalizeGeneratedTeamPayload(payload) {
    const team = payload?.team || payload;
    if (!team || typeof team !== 'object') {
        throw new Error('Team generator returned an empty response.');
    }
    if (!Array.isArray(team.agents) || team.agents.length === 0) {
        throw new Error('Team generator did not return any agents.');
    }
    return {
        name: team.name || 'Generated Team',
        flags: Array.isArray(team.flags) ? team.flags.join(' ') : (team.flags || ''),
        agents: team.agents,
    };
}

/** "Drafted: 3 members" above the member list until the person edits one (#10517: a draft could not be told from no draft when its names matched the template's). */
function showDraftedNote(n) {
    const list = document.getElementById('team-agents-list'), panel = document.getElementById('team-panel-members');
    if (!list || !panel) return;
    let note = document.getElementById('team-drafted-note');
    if (!note) { note = document.createElement('p'); note.id = 'team-drafted-note'; note.className = 'notice notice-info team-drafted-note'; note.setAttribute('role', 'status'); list.before(note); }
    note.textContent = `Drafted: ${_membersWords(n)}. Change anything below before you launch.`;
    note.hidden = false;
    const done = (e) => { if (e.target && e.target.closest && e.target.closest('#team-drafted-note')) return; if (e.type === 'click' && !(e.target.closest && e.target.closest('#team-agents-list, .team-add-agent-btn, #team-add-orchestrator, #team-set-all'))) return; note.hidden = true; panel.removeEventListener('input', done, true); panel.removeEventListener('click', done, true); };
    panel.addEventListener('input', done, true); panel.addEventListener('click', done, true);
}

function _populateGeneratedTeamDraft(team) {
    launch.skipDefaultTeamAgents = true;
    // Open the launch modal directly to the team step, skipping the chooser.
    // Don't call showLaunchModal() — it resets to the chooser and clears the agent list.
    document.getElementById("launch-modal").style.display = "flex";
    _showLaunchStep("team");
    launch.mode = "team";
    _initTeamForm();

    // Show generated-team banner
    const stepEl = document.getElementById('launch-step-team');
    let banner = document.getElementById('generated-team-banner');
    if (!banner && stepEl) {
        banner = document.createElement('div');
        banner.id = 'generated-team-banner';
        banner.className = 'notice notice-info generated-team-banner';
        banner.innerHTML = '<span class="material-icons" aria-hidden="true">auto_awesome</span> Your AI-generated team is ready — review and edit before launching.';
        const sub = document.getElementById('team-stage-sub'); // under the step line, on a row of its own: beside the title it wrapped "New project" (#10660)
        if (sub) sub.after(banner); else stepEl.prepend(banner);
    }
    if (banner) {
        banner.style.display = 'flex';
        clearTimeout(banner._hide); banner._hide = setTimeout(() => { banner.style.display = 'none'; }, 8000); // display-ok: a passing notice goes by itself; the Members note says the same and stays
    }

    const teamNameEl = document.getElementById('team-board-name');
    const teamFlagsEl = document.getElementById('team-flags');
    const teamAgentsList = document.getElementById('team-agents-list');

    if (teamNameEl) {
        teamNameEl.value = team.name || 'Generated Team';
        window._validateTeamName?.();
    }
    if (teamFlagsEl) {
        teamFlagsEl.value = team.flags || '';
        _syncFlagButtons('team-flags');
    }
    if (teamAgentsList) {
        launch.teamAgentCounter = 0;
        teamAgentsList.innerHTML = '';
    }

    for (const agent of team.agents) {
        _addTeamAgent(
            agent.name || '',
            agent.prompt || '',
            agent.capabilities,
            agent.agent_type,
            agent.model,
        );
    }
    showDraftedNote(team.agents.length);
    markGeneratedTeam(team.agents.length);
    showTeamStep('members'); // the drafted members are what is on screen: the name and the folder are one Back away (#10517) // the template choice says where the members came from, not Blank team (#9911)
}

let _activeGenerateJobId = null;
let _generatePollTimer = null;

async function generateTeamFromWizard() {
    const directiveEl = document.getElementById('team-wizard-directive');
    const generateBtn = document.getElementById('team-wizard-generate-btn');
    const directive = directiveEl?.value.trim() || '';
    const composition = ''; // one box: who should be on the team is part of what the person describes; the server infers a team from it

    // Disable immediately to prevent double submissions
    if (generateBtn) generateBtn.disabled = true;

    if (!directive) {
        _setTeamWizardError('Describe your team first: what it should do, and who should be on it, for example "an orchestrator, a developer and a tester to build a login page".');
        directiveEl?.focus();
        if (generateBtn) generateBtn.disabled = false;
        return;
    }
    _setTeamWizardError('');
    if (generateBtn) {
        generateBtn.textContent = 'Generating...';
    }

    try {
        // Submit job and get job ID
        const resp = await fetch('/api/teams/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directive, composition }),
        });

        let payload = null;
        try { payload = await resp.json(); } catch { payload = null; }

        if (!resp.ok || payload?.error) {
            throw new Error(payload?.error || `Team generation failed (${resp.status}).`);
        }

        // If backend returns a job_id, poll for results
        if (payload?.job_id) {
            _activeGenerateJobId = payload.job_id;
            _startGeneratePolling(payload.job_id);
            return;
        }

        // Synchronous response (no job_id) — handle inline
        _handleGenerateResult(payload);
    } catch (error) {
        _setTeamWizardError(_plainGenerateError(error.message || 'Team generation failed.'));
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate team';
        }
    }
}
window.generateTeamFromWizard = generateTeamFromWizard;

function _startGeneratePolling(jobId) {
    if (_generatePollTimer) clearInterval(_generatePollTimer);
    _generatePollTimer = pollEvery(async () => {
        try {
            const resp = await fetch(`/api/teams/generate/${encodeURIComponent(jobId)}`);
            const data = await resp.json();

            if (data.status === 'pending') return; // still running

            // Job finished — stop polling
            clearInterval(_generatePollTimer);
            _generatePollTimer = null;
            _activeGenerateJobId = null;

            if (data.status === 'error') {
                _handleGenerateError(data.error || 'Team generation failed.');
                return;
            }

            // Success
            _handleGenerateResult(data.result || data);
        } catch {
            // Network error — keep polling
        }
    }, 2500);
}

function _isWizardOpen() {
    const modal = document.getElementById('team-wizard-modal');
    return modal && modal.style.display !== 'none';
}

function _handleGenerateResult(payload) {
    try {
        const team = _normalizeGeneratedTeamPayload(payload);
        _pendingGeneratedTeam = team;

        if (_isWizardOpen()) {
            _reviewGeneratedTeam(); // straight to the drafted members: Review Team was the one thing to press (#10517)
        } else {
            // Wizard was closed — show a notification toast with action
            showToast(`AI team "${team.name}" is ready (${team.agents.length} agents)`, false);
            // Auto-open the review flow
            _reviewGeneratedTeam();
        }
    } catch (error) {
        _handleGenerateError(error.message || 'Failed to parse generated team.');
    }
}

function _handleGenerateError(message) {
    message = _plainGenerateError(message);
    if (_isWizardOpen()) {
        _setTeamWizardError(message);
        const generateBtn = document.getElementById('team-wizard-generate-btn');
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate team';
        }
    } else {
        showToast(message, true);
    }
}

let _pendingGeneratedTeam = null;

function _reviewGeneratedTeam() {
    const team = _pendingGeneratedTeam;
    if (!team) return;
    _pendingGeneratedTeam = null;
    hideTeamWizardModal();
    _populateGeneratedTeamDraft(team);
}

/** The sample's three members: names no template uses, so a draft is told apart from the template it replaced (#10517). */
const SAMPLE_AGENTS = [
            { name: 'Sample Orchestrator', prompt: 'You are the orchestrator. Break down the task, assign work to the team via the message board, and track progress.', capabilities: { allow: ['file_read', 'file_write', 'shell', 'git_write', 'agent_spawn', 'web_access'], deny: [] }, agent_type: 'claude', model: '' },
            { name: 'Sample Builder', prompt: 'You are a developer. Implement features, write code, and fix bugs. Wait for instructions from the Orchestrator.', capabilities: { allow: ['file_read', 'file_write', 'shell'], deny: [] }, agent_type: 'claude', model: '' },
            { name: 'Sample Reviewer', prompt: 'You are a QA engineer. Review code, write tests, and verify work. Wait for instructions from the Orchestrator.', capabilities: { allow: ['file_read', 'file_write', 'shell'], deny: [] }, agent_type: 'claude', model: '' },
];

async function testTeamWizard() {
    const sampleTeam = {
        name: 'sample-team',
        flags: '',
        agents: SAMPLE_AGENTS,
    };

    _pendingGeneratedTeam = sampleTeam;
    _reviewGeneratedTeam(); // the sample goes straight to the Members step, as a generated draft does (#10517)
}
window.testTeamWizard = testTeamWizard;

export { _reviewGeneratedTeam };
