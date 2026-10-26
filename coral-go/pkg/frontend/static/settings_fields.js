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

/** Draws the groups that are fields into the Settings modal's panes (once, when the modal is built). mount is mountSettingsView. */
export function drawSettingsGroups(modal, mount) {
    for (const [hostId, fields] of [['settings-general-rows', GENERAL_FIELDS]]) {
        const host = modal.querySelector(`#${hostId}`);
        if (host && !host.firstChild) mount(host, { mode: 'settings', saveBar: false, fields });
    }
}
