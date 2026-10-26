/* The main Settings' rows as fields (#7744, #7838): each group of the Settings dialog is a list of fields drawn by settings_view (the same rows as the team Settings), into the pane's own host. The ids are the contract
 * the dialog (settings_dialog.js) and the suites read and fill by, so each field keeps its id; the dialog's own load and Apply read the controls by id as before (the view has no load and no bar here). A group moves here
 * when its rows do: General first. */

const THEME_OPTIONS = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }];
const AGENT_TYPE_OPTIONS = [{ value: 'claude', label: 'Claude' }, { value: 'agy', label: 'Antigravity (agy)' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'Pi' }];

export const GENERAL_FIELDS = [
    { key: 'theme', type: 'select', id: 'settings-theme', labelId: 'settings-theme-label', label: 'Theme', options: THEME_OPTIONS,
        action: { label: 'Customize Theme', icon: 'palette', small: true, className: 'settings-theme-btn', setup: el => el.setAttribute('data-on-click', 'm-hide-settings-modal-then-show-theme-configurator') } },
    { key: 'default_agent_type', type: 'select', id: 'settings-agent-type', labelId: 'settings-agent-type-label', label: 'Default agent type', options: AGENT_TYPE_OPTIONS },
    { key: 'group_by_team', type: 'toggle', id: 'settings-group-by-team', label: 'Group agents by board or team', setup: el => el.setAttribute('data-on-change', 'm-toggle-group-by-team') },
    { key: 'show_session_summary', type: 'toggle', id: 'settings-show-summary', label: 'Summary under each agent', help: 'The agent\'s goal, in one line.', setup: el => el.setAttribute('data-on-change', 'm-toggle-session-summary') },
    { key: 'show_scrollbars', type: 'toggle', id: 'settings-show-scrollbars', label: 'Show scrollbars', help: 'Terminal and chat views.', default: true },
    { key: 'check_updates', type: 'toggle', id: 'settings-check-updates', label: 'Tell me when a new version is out', help: { text: '', more: 'A notice in this browser. Downloading and installing are under Updates.' } },
];

export const NOTIFICATIONS_FIELDS = [
    { key: 'notify_needs_input', type: 'toggle', id: 'settings-notify-needs-input', label: 'Show notifications in Coral', help: 'Show a toast when an agent needs input.' },
    { key: 'desktop_notify', type: 'toggle', id: 'settings-desktop-notify', label: 'Desktop alerts',
        help: { text: '', more: 'This browser only: alert while this tab is in the background. Shows the agent and server names (your OS may keep them in its notification history), never agent output. May duplicate a local alert.' } },
];

export const FILES_FIELDS = [
    { key: 'file_search_mode', type: 'select', id: 'settings-file-search-mode', label: 'File search mode', help: 'How @ mentions and file browser search for files', options: [{ value: 'directory', label: 'Directory Browsing' }, { value: 'fuzzy', label: 'Fuzzy Matching' }] },
    { key: 'file_search_limit', type: 'select', id: 'settings-file-search-limit', label: 'File search limit', help: 'Max number of files returned in search results', default: '500',
        options: [{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }, { value: '1000', label: '1,000' }] },
    { key: 'git_diff_mode', type: 'select', id: 'settings-git-diff-mode', label: 'Git diff mode', help: 'What to compare changed files against',
        options: [{ value: 'branch_point', label: 'Branch Point (merge-base)' }, { value: 'previous_commit', label: 'Previous Commit (HEAD~1)' }, { value: 'main_head', label: 'Main Branch (vs main)' }] },
    { key: 'git_poll_interval', type: 'select', id: 'settings-git-poll-interval', label: 'Git scan interval', help: { text: '', more: 'How often Coral rescans git for changed files. Scanning a large repository is slow \u2014 stretch this out, or turn it off and use the refresh button.' },
        options: [{ value: '30', label: 'Every 30 seconds' }, { value: '60', label: 'Every minute' }, { value: '120', label: 'Every 2 minutes' }, { value: '300', label: 'Every 5 minutes' }, { value: '600', label: 'Every 10 minutes' }, { value: '1800', label: 'Every 30 minutes' }, { value: '0', label: 'Off \u2014 refresh manually' }] },
];

// A live part of a group (filled by its own module, shown or hidden by it): moved from where the template holds it into its place among the rows.
const live = id => ({ key: `live_${id}`, type: 'notice', render: slot => { const el = document.getElementById(id); if (el) slot.append(el); } });
const px = n => ({ value: String(n), label: `${n}px` });
export const TERMINAL_FIELDS = [
    { key: 'terminal_font_size', type: 'select', id: 'settings-terminal-font-size', labelId: 'settings-terminal-font-size-label', label: 'Terminal font size', default: '13', options: [10, 11, 12, 13, 14, 16, 18].map(px) },
    { key: 'terminal_scrollback', type: 'select', id: 'settings-terminal-scrollback', labelId: 'settings-terminal-scrollback-label', label: 'Terminal scrollback', default: '20000',
        options: [{ value: '1000', label: '1,000 lines' }, { value: '5000', label: '5,000 lines' }, { value: '10000', label: '10,000 lines' }, { value: '20000', label: '20,000 lines' }, { value: '50000', label: '50,000 lines' }, { value: '100000', label: 'Unlimited (100k)' }] },
    { key: 'fit_pane_width', type: 'toggle', id: 'settings-fit-pane-width', label: 'Fit pane width', help: { text: '', more: 'With the tmux backend, the terminal takes the size of this browser window.' } },
    live('settings-terminal-backend'), live('tb-autowake'), live('settings-tools-folder-dl'), live('settings-engine-more'),
];

/** Draws the groups that are fields into the Settings modal's panes (once, when the modal is built). mount is mountSettingsView. */
export function drawSettingsGroups(modal, mount) {
    for (const [hostId, fields] of [['settings-general-rows', GENERAL_FIELDS], ['settings-notifications-rows', NOTIFICATIONS_FIELDS], ['settings-files-rows', FILES_FIELDS], ['settings-terminal-rows', TERMINAL_FIELDS]]) {
        const host = modal.querySelector(`#${hostId}`);
        if (host && !host.firstChild) mount(host, { mode: 'settings', saveBar: false, fields });
    }
}
