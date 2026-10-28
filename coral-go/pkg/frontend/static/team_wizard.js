/* The AI team wizard (moved out of team_dialogs.js as it was, #5174; no behaviour change): the dialog, the generate job and its poll, and the generated draft handed to the Agent Team form. */
import { importOnce } from './import_once.js';
import { closeOnBackdropAndEscape, releaseEscape } from './dialog_close.js';
import { showToast, escapeHtml } from './utils.js';
import { pollEvery } from './overload.js';
const { launch } = await importOnce('./launch_state.js');
const { _showLaunchStep } = await importOnce('./launch_core.js');
const { _syncFlagButtons } = await importOnce('./flag_shortcuts.js');
const { _initTeamForm, _addTeamAgent } = await importOnce('./team_dialogs.js');
const { markGeneratedTeam } = await importOnce('./team_templates_ui.js');

function _setTeamWizardError(message = '') {
    const errorEl = document.getElementById('team-wizard-error');
    if (!errorEl) return;
    if (message) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
        return;
    }
    errorEl.textContent = '';
    errorEl.style.display = 'none';
}

/** "1 member" / "3 members": a team's agents are its members everywhere else in the New team flow (#10314). */
const _membersWords = n => `${n} member${n === 1 ? '' : 's'}`;

/** What went wrong in words that end with what to do next (#10314): a draft with no members says what to ask for; any other failure says to try again or use a template. */
function _plainGenerateError(message) {
    const m = String(message || '');
    if (/no agents|any agents|empty response/i.test(m)) return 'The draft had no members. Try again and name the roles you want, for example "an orchestrator, a developer and a tester".';
    return /try again|pick a template/i.test(m) ? m : `${m.replace(/\s*\.?$/, '.')} Try again, or pick a template instead.`;
}

let _wizardBodyOriginalHTML = null;

function showTeamWizardModal() {
    const modal = document.getElementById('team-wizard-modal');
    if (!modal) return;

    // Restore wizard body if it was replaced by success state
    const body = modal.querySelector('.team-wizard-body');
    if (body && _wizardBodyOriginalHTML && body.querySelector('.team-wizard-success')) {
        body.innerHTML = _wizardBodyOriginalHTML;
    } else if (body && !_wizardBodyOriginalHTML) {
        _wizardBodyOriginalHTML = body.innerHTML;
    }

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
            generateBtn.textContent = 'Generate Team';
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
        const h3 = stepEl.querySelector('h3');
        if (h3) h3.after(banner);
    }
    if (banner) banner.style.display = 'flex';

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
    markGeneratedTeam(team.agents.length); // the template choice says where the members came from, not Blank team (#9911)
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
            generateBtn.textContent = 'Generate Team';
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
            // Show success state inline in wizard
            const body = document.querySelector('.team-wizard-body');
            if (body) {
                body.innerHTML = `
                    <div class="team-wizard-success">
                        <span class="material-icons team-wizard-success-icon" aria-hidden="true">check_circle</span>
                        <strong>Team generated!</strong>
                        <p>${_membersWords(team.agents.length)} drafted for "${escapeHtml(team.name)}"</p>
                        <button class="btn btn-primary" data-on-click="team-generated-review">Review Team</button>
                    </div>
                `;
            }
            const generateBtn = document.getElementById('team-wizard-generate-btn');
            if (generateBtn) generateBtn.style.display = 'none';
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
            generateBtn.textContent = 'Generate Team';
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

async function testTeamWizard() {
    const generateBtn = document.getElementById('team-wizard-generate-btn');
    const testBtn = document.getElementById('team-wizard-test-btn');
    if (generateBtn) generateBtn.disabled = true;
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Testing...'; }

    // Simulate a brief delay so loading state is visible
    await new Promise(r => setTimeout(r, 1500));

    const sampleTeam = {
        name: 'test-coding-team',
        flags: '',
        agents: [
            { name: 'Orchestrator', prompt: 'You are the orchestrator. Break down the task, assign work to the team via the message board, and track progress.', capabilities: { allow: ['file_read', 'file_write', 'shell', 'git_write', 'agent_spawn', 'web_access'], deny: [] }, agent_type: 'claude', model: '' },
            { name: 'Developer', prompt: 'You are a developer. Implement features, write code, and fix bugs. Wait for instructions from the Orchestrator.', capabilities: { allow: ['file_read', 'file_write', 'shell'], deny: [] }, agent_type: 'claude', model: '' },
            { name: 'QA Engineer', prompt: 'You are a QA engineer. Review code, write tests, and verify work. Wait for instructions from the Orchestrator.', capabilities: { allow: ['file_read', 'file_write', 'shell'], deny: [] }, agent_type: 'claude', model: '' },
        ],
    };

    _pendingGeneratedTeam = sampleTeam;

    const body = document.querySelector('.team-wizard-body');
    if (body) {
        body.innerHTML = `
            <div class="team-wizard-success">
                <span class="material-icons team-wizard-success-icon" aria-hidden="true">check_circle</span>
                <strong>Team generated!</strong>
                <p>${_membersWords(sampleTeam.agents.length)} drafted for "${escapeHtml(sampleTeam.name)}"</p>
                <button class="btn btn-primary" data-on-click="team-generated-review">Review Team</button>
            </div>
        `;
    }
    if (generateBtn) generateBtn.style.display = 'none';
    if (testBtn) testBtn.style.display = 'none';
}
window.testTeamWizard = testTeamWizard;

export { _reviewGeneratedTeam };
