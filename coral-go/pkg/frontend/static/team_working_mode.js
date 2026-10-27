import { importOnce } from './import_once.js';
import { escapeHtml, escapeAttr } from './utils.js';
const { infoButton, infoBox } = await importOnce('./info_toggle.js'); // lazy modules load the others they need through importOnce, so a failed load is retried

const PRESET_NAMES = { none: 'None', shared_checkout: 'Shared checkout', worktrees: 'Worktrees', merge_queue: 'Merge queue', task_queue: 'Task queue' };

export function hasUnsavedTeamSettings() {
    const page = document.getElementById('team-settings-workspace'); // the team page's Settings tab (settings_view): any part holding a change, asked of the view itself
    return Boolean(page && page.hasUnsaved && page.hasUnsaved());
}

/** Resolves true when leaving the team settings panel may go ahead: nothing unsaved, or the user
 *  chose to leave in the confirm dialog (Cancel, Escape and a replaced dialog all resolve false). */
export function confirmTeamWorkspaceChange() {
    if (!hasUnsavedTeamSettings()) return Promise.resolve(true);
    return new Promise(resolve => window.showConfirmModal('Unsaved Team Settings', 'Team settings have unsaved changes. Leave without saving?',
        () => resolve(true), () => resolve(false), { label: 'Leave', cancelLabel: 'Keep editing' }));
}

/** Open the team's settings (#8853: a popout over the page on screen; the team page has no Settings tab). */
export function showTeamWorkingModeWorkspace(team) {
    return importOnce('./team_settings_modal.js').then(m => m.openTeamSettings(team));
}

export function jsonError(response, fallback) {
    return response.json().catch(() => ({})).then(data => data.error || fallback);
}

// What the preset form shows for a preset's name and instructions.
export const presetNameText = preset => preset.name || PRESET_NAMES[preset.id] || preset.id;
export const presetInstructionsText = preset => preset.overridden
    ? (preset.instructions ?? '')
    : (preset.instructions ?? preset.default_instructions ?? '');

export function presetLabel(preset) {
    return `${preset.name || PRESET_NAMES[preset.id] || preset.id}${preset.builtin ? ' · built in' : ''}`;
}

export function renderInspection(data, workingMode) {
    const roles = [['orchestrator', 'Orchestrator'], ['worker', 'Agent / worker'], ['task', 'Task defaults']];
    // Keep every prompt available without expanding the page until a reader asks for it.
    const folded = (role, name, title, text) => `<details class="disclosure prompt-inspection-fragment prompt-inspection-folded"><summary>${title}</summary><pre>${escapeHtml(text ?? (role[name] || 'Not configured'))}</pre></details>`;
    const cards = roles.map(([key, label], index) => {
        const role = data?.[key] || {};
        const infoId = `prompt-inspection-${key}-info`;
        const applicability = key === 'task' ? 'Applies on first task claim.' : 'Applies to new board sessions.';
        const explanation = `Scope: ${role.scope || 'global'}. Applies: ${role.applicability || '—'}. Per-task additions are only known when a task is created.`;
        const head = `<h4>${label}</h4><div class="prompt-inspection-meta"><span>${applicability}</span>${infoButton(infoId, `${label} prompts`)}</div>${infoBox(infoId, explanation)}`;
        let body;
        if (key === 'task') {
            const defaultInst = role.default_instructions || '';
            const teamInst = workingMode?.instructions?.trim();
            const composed = defaultInst + (teamInst ? `\n\nTeam working instructions:\n${teamInst}` : '') + '\n\n[+ per-task extra when supplied at creation]';
            body = `${folded(role, null, 'Effective composed task preview (on first claim)', composed)}${folded(role, 'default_instructions', 'Default task instructions')}`;
        } else {
            body = folded(role, 'effective_system', 'Effective system') + folded(role, 'effective_action', 'Effective action') + folded(role, 'system_default', 'System default') + folded(role, 'action_default', 'Action default') + folded(role, 'override', 'Override');
        }
        return `<article class="prompt-inspection-card" data-role="${escapeAttr(key)}"${index ? ' hidden' : ''}>${head}${body}</article>`;
    }).join('');
    const options = roles.map(([key, label]) => `<option value="${escapeAttr(key)}">${label}</option>`).join('');
    return `<div class="prompt-inspection-bar"><label>Show the prompts for <select class="prompt-inspection-role">${options}</select></label><button type="button" class="btn btn-small prompt-inspection-copy">Copy</button></div>${cards}`;
}

/** Draws the team's Settings tab into options.page: a settings_view (team_settings_page.js). */
export async function showTeamWorkingMode(team, options = {}) {
    return (await importOnce('./team_settings_page.js')).showTeamSettingsPage(team, options);
}
