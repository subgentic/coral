/* Moved out of modals.js as it was (#3844): no behaviour change. */
import { importOnce } from './import_once.js';
const { _acfServer, _settingsFor } = await importOnce('./launch_models.js');
import { getEngineName } from './renderers.js';
const { defaultPermissionMode, syncDefaultPermissionMode, trackPermissionPick } = await importOnce('./preset_enforcement.js');
import { state } from './state.js';

/** Map agent type to its permission bypass flag. */
const PERM_FLAGS = {
    claude: '--dangerously-skip-permissions',
    agy: '--dangerously-skip-permissions',
    antigravity: '--dangerously-skip-permissions',
    gemini: '--dangerously-skip-permissions',
    codex: '--full-auto',
    pi: '',
};

export { defaultPermissionMode, syncDefaultPermissionMode, trackPermissionPick }; // pure, in preset_enforcement.js (node-tested)

export const PERMISSION_MODE_DESCRIPTIONS = {
    '': 'Nothing is saved: new agents use Auto.', // Settings' first option while no mode is saved (#7620)
    default: "Asks before acting (each CLI's normal mode)",
    acceptEdits: 'Reads, file edits, and common filesystem commands (mkdir, touch, mv, cp, etc.) — best for iterating on code you\'re reviewing',
    plan: 'Reads only — best for exploring a codebase before changing it',
    auto: 'Everything, with safety checks.',
    dontAsk: 'Only pre-approved tools — best for locked-down CI and scripts',
    bypassPermissions: 'Everything except protected paths — isolated containers and VMs only',
};

// What Auto really is differs by CLI (Security's review of #10000, from _getPermissionFlagsForAgentMode): Claude's --permission-mode auto has a safety classifier; Codex never asks but runs in a workspace sandbox; Antigravity and Gemini get
// --dangerously-skip-permissions (no prompts and no checks at all); Pi has no permission system, so it always acts on its own. A description that says 'with safety checks' is true of Claude only.
export const GENERIC_AUTO_DESCRIPTION = 'Everything; safety checks on Claude only.';
export const NO_CHECKS_DESCRIPTION = 'Everything, with no prompts and no safety checks.';
export const PI_NO_PERMISSIONS = 'Pi has no permission prompts: it always acts on its own.';
const SKIPS_ALL_PROMPTS = ['', 'auto', 'dontAsk', 'bypassPermissions'];
/** What a permission mode allows for this CLI, in words; with no CLI (Settings' own select, which is for all of them) the generic description. */
export function permissionDescription(type, value) {
    const t = String(type || '').toLowerCase(), v = value || '';
    if (t === 'pi') return PI_NO_PERMISSIONS;
    if ((t === 'agy' || t === 'antigravity' || t === 'gemini') && SKIPS_ALL_PROMPTS.includes(v)) return NO_CHECKS_DESCRIPTION;
    if (t === 'codex' && CODEX_NETWORK_MODES.includes(v)) return CODEX_AUTO_DESCRIPTION;
    if (!t && v === 'auto') return GENERIC_AUTO_DESCRIPTION; // Settings' own select is for every CLI, and safety checks are Claude's only: it must not say 'with safety checks' (#10191)
    return PERMISSION_MODE_DESCRIPTIONS[v] || '';
}

// Codex's Auto is a workspace sandbox with the network on (Security's #7483): a board member needs it to reach Coral
// Codex launches these as workspace-write that never asks, which has the network on (Security's #7503); so does Codex with no mode: its Default is the same launch (codex.go, #7527)
export const CODEX_NETWORK_MODES = ['default', 'auto', 'dontAsk'];
export const CODEX_AUTO_DESCRIPTION = 'Workspace sandbox, with the network on so it can reach Coral.';

// The modes in which an agent's launch of a worker is refused: agent.SkipsPermissionPrompts keeps only Default as asking (Plan too, for the CLIs other than Claude, #5894)
const WORKERS_REFUSED = { plan: 'Claude agents cannot start workers in this mode.' };
const WORKERS_REFUSED_ANY = 'Agents cannot start workers in this mode.';

// `unset`: nothing is saved, so nothing is refused, though the select reads Auto (Security's #7587 point: only a saved mode, or a pick that will be saved, refuses)
export function _updatePermModeDescription(selectEl, unset = false) {
    const warn = selectEl.closest('.settings-row, .sv-row')?.querySelector('.perm-mode-warn'); // only the Settings row has it
    if (warn) {
        warn.textContent = WORKERS_REFUSED[selectEl.value] || WORKERS_REFUSED_ANY;
        warn.hidden = unset || selectEl.value === 'default' || selectEl.value === ''; // nothing saved refuses nothing
    }
    const hint = selectEl.parentElement?.querySelector('.perm-mode-desc') || selectEl.closest('.settings-row, .sv-row')?.querySelector('.perm-mode-desc'); // Settings' line is in the label, not beside the select
    if (!hint) return;
    hint.textContent = permissionDescription(selectEl.closest('[data-acf-uid]')?.querySelector('.acf-agent-type')?.value, selectEl.value);
}

export function _getPermissionFlagsForAgentMode(agentType, mode) {
    const permMode = mode || defaultPermissionMode(state.settings, agentType);
    if (!permMode || permMode === 'default' || agentType === 'pi' || agentType === 'terminal') return '';
    if (agentType === 'claude') return `--permission-mode ${permMode}`;
    if (agentType === 'agy' || agentType === 'antigravity' || agentType === 'gemini') {
        if (permMode === 'plan') return '--mode plan';
        if (permMode === 'acceptEdits') return '--mode accept-edits';
        return '--dangerously-skip-permissions';
    }
    if (agentType === 'codex') {
        if (permMode === 'bypassPermissions') return '--dangerously-bypass-approvals-and-sandbox';
        if (permMode === 'plan') return '--sandbox read-only -a on-request';
        if (permMode === 'acceptEdits') return '--sandbox workspace-write -a on-request';
        if (permMode === 'auto' || permMode === 'dontAsk') return '--sandbox workspace-write -a never';
        return '--sandbox workspace-write -a on-request';
    }
    return PERM_FLAGS[agentType] || '';
}

export function _stripPermFlags(flagsStr) {
    const known = new Set(Object.values(PERM_FLAGS).filter(Boolean));
    known.add('--dangerously-bypass-approvals-and-sandbox');
    known.add('--dangerously-skip-permissions');
    known.add('--yolo');
    const tokens = (flagsStr || '').split(/\s+/).filter(Boolean);
    const kept = [];
    for (let i = 0; i < tokens.length; i++) {
        const flag = tokens[i];
        if (known.has(flag) || flag === '--search') continue;
        if (flag === '--permission-mode' || flag === '--sandbox' || flag === '--approval-mode' || flag === '-a' || flag === '--mode') {
            i++;
            continue;
        }
        if (
            flag.startsWith('--permission-mode=') ||
            flag.startsWith('--sandbox=') ||
            flag.startsWith('--approval-mode=') ||
            flag.startsWith('--mode=')
        ) {
            continue;
        }
        kept.push(flag);
    }
    return kept.join(' ');
}

export function _normalizePermFlagsForAgent(flagsStr, agentType, mode) {
    const base = _stripPermFlags(flagsStr);
    const permFlags = _getPermissionFlagsForAgentMode(agentType, mode);
    return [base, permFlags].filter(Boolean).join(' ');
}

export function _permissionModeFromFlags(flagsStr) {
    const flags = flagsStr || '';
    const modeMatch = flags.match(/--permission-mode(?:\s+|=)(\S+)/);
    if (modeMatch) return modeMatch[1];
    if (flags.includes('--dangerously-bypass-approvals-and-sandbox')) return 'bypassPermissions';
    if (flags.includes('--full-auto') || flags.includes('--dangerously-skip-permissions') || flags.includes('--yolo')) return 'bypassPermissions';
    if (/--sandbox(?:\s+|=)read-only/.test(flags)) return 'plan';
    if (/--sandbox(?:\s+|=)workspace-write/.test(flags)) return 'auto';
    return '';
}

function _getPermFlagHelp(agentType) {
    const mode = defaultPermissionMode(state.settings, agentType);
    const flag = _getPermissionFlagsForAgentMode(agentType, mode);
    const agentLabel = getEngineName(agentType || 'claude');
    if (agentType === 'pi') {
        return `${agentLabel} runs full-auto by design — no permission flag needed.`;
    }
    if (agentType === 'claude') {
        return `High-autonomy launch for ${agentLabel}. Coral adds ${flag} so the agent can run without interactive permission prompts.`;
    }
    return `High-autonomy launch for ${agentLabel}. Coral adds ${flag} so the agent can run without interactive permission prompts.`;
}

/** Update permission flag shortcut buttons in the same modal as the agent type select. */
function _updatePermFlagButtons(selectEl) {
    const agentType = selectEl.value || 'claude';
    const mode = defaultPermissionMode(state.settings, agentType);
    const flag = _getPermissionFlagsForAgentMode(agentType, mode);

    // Find the enclosing modal content and update all flag-shortcut-btn that reference skip-permissions/full-auto
    const modal = selectEl.closest('.modal-content') || selectEl.closest('.modal');
    if (!modal) return;

    // The permission button: the shortcut whose flag is a skip-permissions or full-auto one, or that
    // this function already switched (data-on-click="flag-perm"). Found by its data attributes, never
    // by handler text (#3645): it now sets the agent type's permission flags for the saved mode.
    modal.querySelectorAll('.flag-shortcut-btn').forEach(btn => {
        const isPerm = btn.getAttribute('data-on-click') === 'flag-perm' || /dangerously-|full-auto/.test(btn.dataset.flag || '');
        if (!isPerm || !btn.dataset.flagInput) return;
        btn.setAttribute('data-on-click', 'flag-perm');
        btn.dataset.agentType = agentType;
        btn.dataset.mode = mode;
        btn.dataset.flag = flag;
        btn.textContent = flag;
    });

    // Also update the flags input value — replace any known perm flag with the new one
    modal.querySelectorAll('input[id*=flags]').forEach(input => {
        const mode = defaultPermissionMode(state.settings, agentType);
        input.value = _normalizePermFlagsForAgent(input.value, agentType, mode);
    });
}
window._updatePermFlagButtons = _updatePermFlagButtons;
window._updatePermModeDescription = _updatePermModeDescription;

/** Check if a flags string contains ANY known permission flag. */
export function _hasPermFlag(flagsStr) {
    return Object.values(PERM_FLAGS).filter(Boolean).some(f => flagsStr.includes(f)) ||
        flagsStr.includes('--dangerously-bypass-approvals-and-sandbox') ||
        flagsStr.includes('--dangerously-skip-permissions') ||
        flagsStr.includes('--yolo') ||
        /--permission-mode(?:\s+|=)\S+/.test(flagsStr) ||
        /--sandbox(?:\s+|=)\S+/.test(flagsStr) ||
        /--mode(?:\s+|=)\S+/.test(flagsStr) ||
        /(?:^|\s)(?:-a|--approval-mode)(?:\s+|=)\S+/.test(flagsStr);
}

export function _syncACFAutoPermissions(container) {
    if (!container) return;
    const typeEl = container.querySelector('.acf-agent-type');
    const toggleEl = container.querySelector('.acf-auto-permissions');
    const noteEl = container.querySelector('.acf-auto-permissions-note');
    const flagEl = container.querySelector('.acf-auto-permissions-flag');
    if (!typeEl || !toggleEl || !noteEl || !flagEl) return;

    const agentType = typeEl.value || 'claude';
    const mode = container.querySelector('.acf-permission-mode')?.value ||
        defaultPermissionMode(_settingsFor(_acfServer(container)), agentType);
    const flag = _getPermissionFlagsForAgentMode(agentType, mode);
    flagEl.textContent = flag;
    noteEl.textContent = _getPermFlagHelp(agentType);
    noteEl.style.opacity = toggleEl.checked ? '1' : '0.72';
}
