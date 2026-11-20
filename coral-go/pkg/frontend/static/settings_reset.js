/* Settings-only defaults, in the same control values as settings_fill.js. Actions,
 * credentials and collections have no factory value and never get a Reset. */
import { defaultTerminalFont } from './terminal_font.js';

const DEFAULTS = {
    'settings-theme': 'system', 'settings-agent-type': 'claude',
    'settings-group-by-team': true, 'settings-show-scrollbars': true,
    'settings-check-updates': true, 'settings-fit-pane-width': false,
    'settings-terminal-scrollback': '20000', 'settings-notify-needs-input': false,
    'settings-working-dir': '', 'settings-permission-mode': 'auto',
    'settings-auto-resume': false, 'settings-auto-sleep': true,
    'settings-auto-sleep-minutes': '60', 'settings-auto-goals': true,
    'settings-agent-low-priority': true, 'settings-board-auto-attach': false,
    'settings-nudge-claude-artifacts': true, 'settings-board-health-monitor': true,
    'settings-launch-in-worktree': false, 'settings-renderer-select': 'xterm',
    'settings-file-search-mode': 'directory', 'settings-file-search-limit': '500',
    'settings-git-diff-mode': 'branch_point', 'settings-git-poll-interval': '120',
    'settings-inbox-file': true, 'settings-inbox-done': true,
    'settings-inbox-release': true, 'settings-inbox-decided': true,
    'settings-inbox-digest': true, 'settings-inbox-digest-time': '09:00',
    'settings-telemetry-enabled': true, 'settings-debug-input-log': false,
    'settings-remote-access-enabled': false,
};
for (const provider of ['claude', 'codex', 'agy', 'pi']) {
    for (const field of ['default-model', 'default-thinking', 'orchestrator-model', 'orchestrator-thinking', 'cli-path']) DEFAULTS[`settings-${field}-${provider}`] = '';
}
DEFAULTS['settings-cli-path-opencode'] = '';
const read = e => e.type === 'checkbox' ? e.checked : e.value;
const value = id => id === 'settings-terminal-font-size' ? String(defaultTerminalFont()) : DEFAULTS[id];
const defaulted = e => read(e) === value(e.id) || (e.id === 'settings-permission-mode' && e.value === '');

export function refreshSettingsResets(modal) {
    for (const button of modal.querySelectorAll('[data-reset-setting]')) {
        const e = document.getElementById(button.dataset.resetSetting);
        const box = button.parentElement;
        box.hidden = defaulted(e);
        button.disabled = e.disabled || e.readOnly || e.dataset.saving === '1';
    }
}

export function wireSettingsResets(modal, reset) {
    if (!modal._resetObserver) {
        modal._resetObserver = new MutationObserver(() => refreshSettingsResets(modal));
        modal._resetObserver.observe(modal, { childList: true, subtree: true });
    }
    for (const id of [...Object.keys(DEFAULTS), 'settings-terminal-font-size']) {
        const e = document.getElementById(id), row = e?.closest('.sv-row');
        if (!row || !e.closest('[data-autosaves]') || row.querySelector('[data-reset-setting]')) continue;
        const box = document.createElement('span'); box.className = 'settings-reset';
        const dot = document.createElement('span'); dot.className = 'settings-default-dot'; dot.setAttribute('aria-hidden', 'true'); // the dot is drawn by CSS: no text of its own to count or read
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-quiet btn-small'; button.textContent = 'Reset'; button.dataset.resetSetting = id;
        const provider = id.match(/-(claude|codex|agy|pi|opencode)$/), label = (row.querySelector('.sv-label')?.textContent || e.getAttribute('aria-label') || 'setting') + (provider ? ` for ${provider[1][0].toUpperCase()}${provider[1].slice(1)}` : ''); // two providers' rows say the same label: each Reset names its own
        button.setAttribute('aria-label', `Reset ${label} to default. Changed from default.`); box.title = 'Changed from default';
        box.append(dot, button); const at = row.querySelector('.sv-label'); if (at) at.after(box); else (row.querySelector('.sv-text') || row).append(box); // beside the label, on its own line: a Reset that appears adds no height
        button.addEventListener('click', async () => {
            if (e.disabled || e.readOnly || e.dataset.saving === '1') return;
            // Keep focus on the setting after its Reset disappears. The regular saver
            // keeps its previous snapshot, validates and rolls back on failure.
            e.focus(); await reset(e, value(id)); refreshSettingsResets(modal);
        });
    }
    refreshSettingsResets(modal);
}
