/* The main Settings' rows as fields (#7744, #7838): each group of the Settings dialog is a list of fields drawn by settings_view (the same rows as the team Settings), into the pane's own host. The ids are the contract
 * the dialog (settings_dialog.js) and the suites read and fill by, so each field keeps its id; the dialog's own load and Apply read the controls by id as before (the view has no load and no bar here). A group moves here
 * when its rows do: General first. */

const THEME_OPTIONS = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }];
const AGENT_TYPE_OPTIONS = [{ value: 'claude', label: 'Claude' }, { value: 'agy', label: 'Antigravity (agy)' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'Pi' }];

const GENERAL_FIELDS = [
    { key: 'theme', type: 'select', id: 'settings-theme', labelId: 'settings-theme-label', label: 'Theme', options: THEME_OPTIONS,
        action: { label: 'Customize Theme', icon: 'palette', small: true, className: 'settings-theme-btn', setup: el => el.setAttribute('data-on-click', 'm-hide-settings-modal-then-show-theme-configurator') } },
    { key: 'default_agent_type', type: 'select', id: 'settings-agent-type', labelId: 'settings-agent-type-label', label: 'Default agent type', options: AGENT_TYPE_OPTIONS },
    { key: 'group_by_team', type: 'toggle', id: 'settings-group-by-team', label: 'Group agents by team', help: 'Agents on the same team sit together in the list.', setup: el => el.setAttribute('data-on-change', 'm-toggle-group-by-team') },
    { key: 'show_scrollbars', type: 'toggle', id: 'settings-show-scrollbars', label: 'Show scrollbars', help: 'Terminal and chat views.', default: true },
    { key: 'check_updates', type: 'toggle', id: 'settings-check-updates', label: 'Tell me when a new version is out', help: { text: '', more: 'A notice in this browser. Downloading and installing are under Updates.' } },
];

/** The alert kinds wait for Desktop alerts to be on (the dialog redraws its rows on every change, so the rule lives in the field, not only in the fill). */
const alertsOff = () => { const e = document.getElementById('settings-desktop-notify'); return !e || !e.checked; };

const NOTIFICATIONS_FIELDS = [
    { key: 'notify_needs_input', type: 'toggle', id: 'settings-notify-needs-input', label: 'Show notifications in Coral', help: 'A message in Coral when an agent needs input.' },
    { key: 'desktop_notify', type: 'toggle', id: 'settings-desktop-notify', label: 'Desktop alerts',
        help: { text: 'An alert on this computer while this tab is in the background.', more: 'This browser only. Shows the agent and server names (your OS may keep them in its notification history), never agent output. May duplicate a local alert.' } },
    // Why the switch above did not turn on (#10068): a browser that blocks alerts, or a permission box that was dismissed. Filled by settings_fill.js.
    { key: 'desktop_notify_blocked', type: 'notice', render: slot => { const p = document.createElement('p'); p.id = 'settings-desktop-blocked'; p.className = 'sv-help'; p.setAttribute('role', 'status'); p.hidden = true; slot.append(p); } },
    // This browser's own choices about those alerts (not saved on the server); they apply while Desktop alerts is on.
    { key: 'alert_needs_input', type: 'toggle', id: 'settings-alert-needs-input', label: 'Alert when an agent needs input', disabledWhen: () => alertsOff() },
    { key: 'alert_reply', type: 'toggle', id: 'settings-alert-reply', label: 'Alert when an agent finishes a reply', disabledWhen: () => alertsOff() },
    { key: 'alert_sound', type: 'toggle', id: 'settings-alert-sound', label: 'Play a sound with alerts', help: "Your computer's own alert sound.", disabledWhen: () => alertsOff() },
];

const FILES_FIELDS = [
    { key: 'file_search_mode', type: 'select', id: 'settings-file-search-mode', label: 'File search mode', help: 'How @ mentions and file browser search for files', options: [{ value: 'directory', label: 'Directory Browsing' }, { value: 'fuzzy', label: 'Fuzzy Matching' }] },
    { key: 'file_search_limit', type: 'select', id: 'settings-file-search-limit', label: 'File search limit', help: 'Max number of files returned in search results', default: '500',
        options: [{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }, { value: '1000', label: '1,000' }] },
    { key: 'git_diff_mode', type: 'select', id: 'settings-git-diff-mode', label: 'Git diff mode', help: 'What to compare changed files against',
        options: [{ value: 'uncommitted', label: 'Uncommitted changes' }, { value: 'last_commit', label: 'Last commit' }, { value: 'branch_point', label: 'Since branch point (merge-base)' }, { value: 'previous_commit', label: 'Last commit + uncommitted (vs HEAD~1)' }, { value: 'main_head', label: 'Compared with main' }] },
    { key: 'git_poll_interval', type: 'select', id: 'settings-git-poll-interval', label: 'Git scan interval', help: { text: '', more: 'How often Coral rescans git for changed files. Scanning a large repository is slow \u2014 stretch this out, or turn it off and use the refresh button.' },
        options: [{ value: '30', label: 'Every 30 seconds' }, { value: '60', label: 'Every minute' }, { value: '120', label: 'Every 2 minutes' }, { value: '300', label: 'Every 5 minutes' }, { value: '600', label: 'Every 10 minutes' }, { value: '1800', label: 'Every 30 minutes' }, { value: '0', label: 'Off \u2014 refresh manually' }] },
];

// A live part of a group (filled by its own module, shown or hidden by it): moved from where the template holds it into its place among the rows.
const live = id => ({ key: `live_${id}`, type: 'notice', render: slot => { const el = document.getElementById(id); if (el) slot.append(el); } });
const px = n => ({ value: String(n), label: `${n}px` });
// The terminal backend and waking the agents (#3634, #3636): rows of this pane that terminal_backend.js fills and shows once it has read the status (never through Coral Hub).
// Settings > Terminal backend: tmux keeps agents running across Coral restarts but any agent can reach other agents' terminals through its socket; pty isolates agents, which end when Coral restarts.
const OS_NOTE = {
    mac: "macOS: with pty, other programs normally cannot reach Coral's terminals; with tmux they can, through the socket. Neither backend separates Coral from programs running with your full user rights; for that, run agents under a separate account.",
    linux: "Linux: with pty, a program running as you can still reach Coral's terminals through /proc today, so pty protects agents from tmux-style access, not from every program running as you.",
};
const osNote = () => (`${navigator.userAgentData?.platform || navigator.platform || ''}`.toLowerCase().includes('linux') ? OS_NOTE.linux : OS_NOTE.mac);
export const TERMINAL_BACKEND_IDS = ['tb-choice', 'tb-fixed', 'tb-now', 'tb-pending', 'tb-autowake-on', 'tb-autowake-cap']; // the ids of the rows that start hidden
// The one line under the backend choice says what the chosen backend does (#9490): it follows the select, and the pty sentence says they wake next time only while Wake agents after a restart is on (#6263).
const BACKEND_HINT = { tmux: "Agents keep running when you quit Coral, and can reach each other's terminals.", ptyWake: 'Agents stop when you quit Coral and wake next time.', pty: 'Agents stop when you quit Coral.' };
export const backendHint = () => {
    const sel = document.getElementById('tb-choice'), wake = document.getElementById('tb-autowake-on');
    return !sel || sel.value === 'tmux' ? BACKEND_HINT.tmux : (wake && wake.checked ? BACKEND_HINT.ptyWake : BACKEND_HINT.pty);
};
const TERMINAL_BACKEND_FIELDS = [
    { key: 'terminal-backend', type: 'select', id: 'tb-choice', labelId: 'tb-choice-label', label: 'Terminal backend',
        helpTextClass: 'tb-hint', helpOf: backendHint, help: { text: "Agents keep running when you quit Coral, and can reach each other's terminals.", about: 'the terminal backends', more: [
            "tmux: Agents keep running when Coral restarts, upgrades or crashes, and Coral picks them up again afterwards. Coral keeps its terminals in a tmux server whose socket sits in your Coral data folder. Any agent, and any other program running as you, can find that socket and read or type into other agents' terminals. Choose this if you restart or upgrade Coral often.",
            'pty: Coral holds each terminal itself, so there is no shared socket for an agent to use against another agent. The price: agents end whenever Coral restarts, upgrades or crashes (Coral puts them to sleep first when it stops cleanly, and marks them asleep at the next start after a crash). When Coral starts again it wakes them one at a time (not if Coral has restarted several times in a row; up to the number set below; more after you confirm; you can turn this off), and they resume their conversation, but a tool that was running is not continued.',
            osNote()].join('\n\n') },
        options: [{ value: 'tmux', label: 'tmux (agents keep running)' }, { value: 'pty', label: 'pty (default)' }] },
    { key: 'tb_fixed', type: 'custom', id: 'tb-fixed', label: 'Terminal backend', render: slot => slot.append("Agents run in Coral's terminals (pty), the only backend here. They stop when Coral quits and wake next time."),
        help: { text: '', more: 'This Coral runs agents in its own terminals (pty), the only backend here (no tmux on this system). Agents end when Coral restarts or upgrades; when it starts again Coral wakes them (up to the number set below; more after you confirm; you can turn this off), and they resume their conversation.' } },
    { key: 'tb_now', type: 'custom', id: 'tb-now', label: 'Running now', render: () => {} },
    { key: 'tb_pending', type: 'notice', render: slot => { const p = document.createElement('p'); p.id = 'tb-pending'; p.className = 'sv-help'; p.setAttribute('role', 'status'); slot.append(p); } }, // always in the page, only its text changes: a status that appears with its words is often not read
    { key: 'auto_wake_after_restart', type: 'toggle', id: 'tb-autowake-on', label: 'Wake agents after a restart',
        help: { text: 'Resumes what was running when Coral stopped.', more: 'Coral wakes them one at a time when it starts, and they resume their conversation with the permissions they ran with, including an agent that bypassed permissions. More than the number below: Coral asks first. Agents you put to sleep stay asleep.' } },
    { key: 'auto_wake_cap', type: 'number', id: 'tb-autowake-cap', label: 'Wake up to', unit: 'agents without asking', min: 1, max: 50, step: 1, default: 8, attrs: { inputmode: 'numeric' } },
];
const TERMINAL_FIELDS = [
    { key: 'terminal_display_title', type: 'heading', id: 'settings-terminal-display-title', label: 'Display' },
    { key: 'terminal_font_size', type: 'select', id: 'settings-terminal-font-size', labelId: 'settings-terminal-font-size-label', label: 'Terminal font size', default: '13', options: [10, 11, 12, 13, 14, 16, 18].map(px) },
    { key: 'terminal_scrollback', type: 'select', id: 'settings-terminal-scrollback', labelId: 'settings-terminal-scrollback-label', label: 'Terminal scrollback', default: '20000',
        options: [{ value: '1000', label: '1,000 lines' }, { value: '5000', label: '5,000 lines' }, { value: '10000', label: '10,000 lines' }, { value: '20000', label: '20,000 lines' }, { value: '50000', label: '50,000 lines' }, { value: '100000', label: 'Unlimited (100k)' }] },
    { key: 'fit_pane_width', type: 'toggle', id: 'settings-fit-pane-width', label: 'Fit pane width', help: { text: '', more: 'With the tmux backend, the terminal takes the size of this browser window.' } },
    { key: 'terminal_backend_title', type: 'heading', id: 'settings-terminal-backend-title', label: 'Backend' },
    ...TERMINAL_BACKEND_FIELDS,
    live('settings-tools-folder-dl'), live('settings-engine-more'),
];

const PERMISSION_OPTIONS = [{ value: '', label: 'Not set (Auto)' }, { value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'auto', label: 'Auto' }, { value: 'bypassPermissions', label: 'Bypass permissions' }, { value: 'dontAsk', label: "Don't ask" }];
const THINKING_OPTIONS = [{ value: '', label: "The CLI's own default" }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra high' }, { value: 'max', label: 'Max' }];
// One default-model row: the text box with the model list of its provider (filled by the dialog's model fetch into the datalist).
const modelRow = (provider, label) => ({ key: `default_model_${provider}`, type: 'text', id: `settings-default-model-${provider}`, label, placeholder: 'Leave blank for none',
    attrs: { list: `settings-models-${provider}`, autocomplete: 'off', 'aria-label': `${label} default model` }, setup: el => { el.classList.add('settings-mono-input'); const dl = document.createElement('datalist'); dl.id = `settings-models-${provider}`; el.after(dl); } });
const helpLine = (text, more) => ({ text, more }); // a visible one-line description, with the longer note behind the (i) (#10074)

// One CLI path row: the path (mono, spell check off) with the verify result cli_dialogs.js writes under it.
const cliPath = (type, label) => ({ key: `cli_path_${type}`, type: 'path', id: `settings-cli-path-${type}`, label: `${label} CLI path`, placeholder: type, live: [`cli-result-${type}`], setup: el => el.classList.add('settings-mono-input') });

const AGENTS_FIELDS = host => [
    { key: 'agents_defaults', type: 'heading', id: 'settings-agents-defaults', label: 'Defaults' },
    { key: 'permission_mode', type: 'select', id: 'settings-permission-mode', labelId: 'settings-permission-mode-label', label: 'Default permission mode', options: PERMISSION_OPTIONS,
        help: { text: 'Everything; safety checks on Claude only.', about: 'Default permission mode', more: "Default asks before acting; Auto acts on its own; Not set uses Auto. With such a default, an orchestrator's launches are refused until you pick Default or start them yourself. Auto differs by CLI: Claude checks each action for safety; Codex runs in a workspace sandbox; Antigravity, Gemini and Pi have no safety checks, and Pi has no permission prompts at all." }, helpTextClass: 'perm-mode-desc',
        setup: el => { el.setAttribute('data-on-change', 'm-perm-mode-describe'); const warn = document.createElement('span'); warn.className = 'perm-mode-warn sv-help'; warn.hidden = true; warn.textContent = 'Agents cannot start workers in this mode.'; el.closest('.sv-row').querySelector('.sv-text').append(warn); } }, // the line under the select is the chosen mode's meaning, said once; the three modes side by side are the row's More (#10266, after #10000)
    { key: 'working_dir', type: 'text', id: 'settings-working-dir', label: 'Default working directory', help: 'The folder a new agent starts in.', placeholder: host.dataset.coralRoot || '', attrs: { 'data-coral-root': host.dataset.coralRoot || '' } },
    { key: 'default_thinking_claude', type: 'select', id: 'settings-default-thinking-claude', label: 'Default thinking', options: THINKING_OPTIONS, attrs: { 'aria-label': 'Claude default thinking' },
        help: helpLine('How hard Claude thinks before it answers, when a launch does not say.', 'How much Claude thinks before it answers, for agents launched with no choice of their own. A model that does not take a level uses the nearest one it does.') },
    // the CLI paths: a closed disclosure of four path fields, each with its verify result under it, and Verify All (#8460); the dialog opens it when the default agent's CLI is missing (openCliPathsWhenMissing), which also says on the closed row whether the default CLI was found; it sits under Defaults, not at the foot of the page, where a person whose agent will not start looks (#9955)
    { key: 'cli_paths', type: 'heading', id: 'settings-cli-paths', label: 'CLI paths (empty uses PATH)', fold: true },
    cliPath('claude', 'Claude'), cliPath('codex', 'Codex'), cliPath('agy', 'Antigravity'), cliPath('pi', 'Pi'),
    live('verify-all-btn'),
    { key: 'default_models', type: 'heading', id: 'settings-agents-models', label: 'Default models', help: 'Used when launching an agent without a model specified. Pick from the dropdown or type any model id.' },
    modelRow('claude', 'Claude'), modelRow('codex', 'Codex'), modelRow('agy', 'Antigravity'), modelRow('pi', 'Pi'),
    { key: 'default_models_notice', type: 'notice', render: slot => { slot.innerHTML = '<span id="settings-default-models-notice" class="settings-hint" role="status"></span>'; } },
    { key: 'custom_models', type: 'custom', id: 'settings-custom-models', wide: true, label: 'Custom models', help: { text: 'Model ids are passed to the CLI as they are written here.', more: "They appear in every model picker, including the one that switches a running agent's model." }, // the list and its form: custom_models.js draws them and shows the row once the server has the route
        render: slot => slot.classList.add('settings-custom-models') },
    { key: 'agents_behaviour', type: 'heading', id: 'settings-agents-behaviour', label: 'Behaviour' },
    { key: 'auto_resume', type: 'toggle', id: 'settings-auto-resume', label: 'Resume after API errors', help: helpLine('Wakes an agent again after a rate limit or API error.', "When an agent's CLI stops on a rate limit, an overload or another API error, Coral wakes it again after about 2, then 5, then 15 minutes, and stops trying after the third. Waking the agent yourself starts the count again.") },
    { key: 'auto_goals', type: 'toggle', id: 'settings-auto-goals', label: "Name each agent's goal", help: helpLine('A short line on what the agent is working toward, written from your requests.', "Coral asks Claude Code's smallest model (Haiku) for a short goal line for each agent, from your requests only: once when the agent first answers, then for a new request at most every 30 minutes. Each one is a short call made with your Claude Code account (about 1,300 input tokens). When off, the goal shows your first prompt.") },
    { key: 'agent_low_priority', type: 'toggle', id: 'settings-agent-low-priority', label: 'Run agents at lower priority', help: helpLine('Keeps the dashboard quick while agents are busy.', 'Agents and everything they start (builds, test runs) run below Coral itself (nice +10 on Mac and Linux, below normal on Windows), so the dashboard, Coral Hub and your own apps stay quick while agents use every CPU. It changes scheduling only, never what an agent may do. Applies to agents started after the change.') },
    { key: 'agents_team', type: 'heading', id: 'settings-agents-team', label: 'Team and board' },
    { key: 'board_auto_attach', type: 'toggle', id: 'settings-board-auto-attach', label: 'Attach files linked in posts', help: helpLine('Saves an image or Markdown file an agent links in a post, so the team can open it.', "When on, an agent's own board post that links a local image (png, jpg, gif, webp) or Markdown file changed in the last day has it stored as an artifact, so the team and Coral Hub can open it. When off, links stay as written and agents upload with coral-agent artifact upload.") },
    { key: 'nudge_claude_artifacts', type: 'toggle', id: 'settings-nudge-claude-artifacts', label: 'Coral artifact reminders', help: helpLine('Asks an agent to publish to Coral when it publishes to claude.ai.', 'When an agent publishes to claude.ai, Coral types one note into its terminal asking for a Coral artifact instead (coral-agent artifact upload) and a link to it. Once per artifact; Coral never uploads or posts for the agent. When off, nothing is typed.') },
    { key: 'board_health_monitor', type: 'toggle', id: 'settings-board-health-monitor', label: 'Team health checks', help: 'Applies to every team; each team still turns its own check on in Team settings. Takes effect after Coral restarts.' },
    { key: 'agents_tools', type: 'heading', id: 'settings-agents-tools', label: 'Tools' },
    { key: 'codex_trust_hooks', type: 'toggle', id: 'settings-codex-trust-hooks', label: "Trust Coral's hooks in Codex", help: helpLine('Skips the review step Codex asks for before it runs a new hook.', "Codex asks you to review new hooks before it runs them, because a trusted hook runs outside its sandbox. When this is on and only an administrator can change Coral's tools folder (an installed Coral), Coral trusts its own hooks for each Codex agent it launches, so the agent starts without that question; your own hooks and a repository's still ask. Off, Codex asks every time. Applies to Codex agents launched after the change, and can only be changed on this computer.") },
    live('settings-prompts-live'),
];

export const CLEANUP_FIELDS = [
    { key: 'artifact_store_max', type: 'number', id: 'settings-artifact-store-max', label: 'Artifact store limit', unit: 'GiB', min: 0, step: 1, compact: true, live: ['settings-artifact-store-size', { id: 'settings-storage-breakdown', wide: true }],
        help: { text: 'The most space stored artifacts may take.', more: "Above it, agents' new uploads are refused until you delete some (Team Artifacts > Delete). 0 means no limit. Saved task and session diffs aren't counted." } },
    { key: 'received_max', type: 'number', id: 'settings-received-max', label: 'Received files limit', unit: 'GiB', min: 0, step: 1, compact: true, live: ['settings-received-size', 'settings-received-unlisted'],
        help: { text: 'The most space received files may take.', more: "Files sent to this computer by other teams and Corals. Above it, new received files are refused; nothing is deleted, and your agents' own uploads are not affected. The default is 2; 0 means no limit." } },
    { key: 'free_space', type: 'heading', label: 'Free space' },
    { key: 'prune_days', type: 'number', id: 'settings-prune-days', label: 'Older than', unit: 'days', min: 1, max: 3650, step: 1, default: 14, compact: true,
        help: { text: '', more: 'Prune deletes saved diffs of finished tasks and stopped sessions, and artifacts nothing links, older than the days you choose. Shrink rewrites saved diffs of finished tasks without secrets, dot-files, binaries and big files (the code changes stay). Kept artifacts and anything still linked are never touched. Each shows what it would do first.' } },
    { key: 'prune_kind', type: 'select', id: 'settings-prune-kind', label: 'What to prune', default: 'diffs', options: [{ value: 'diffs', label: 'Saved diffs' }, { value: 'objects', label: 'Unlinked artifacts' }, { value: 'all', label: 'Both' }] },
    live('settings-storage-actions'),
    { key: 'retention_enabled', type: 'toggle', id: 'settings-retention-enabled', label: 'Prune every hour', live: ['settings-retention-status', 'settings-retention-review'],
        help: { text: '', more: 'Does the same as Prune by itself, once an hour. After you turn it on, nothing is removed until you review what it would do, or 24 hours later; each run frees at most 2 GiB.' } },
    { key: 'terminal_logs', type: 'heading', id: 'settings-terminal-logs-title', label: 'Terminal logs', help: { text: 'Kept after an agent is killed.', more: "Each agent's terminal output stays in the logs folder of Coral's data folder. Deleting removes the logs of agents that have ended; the log of a live, sleeping or archived agent is never touched." } },
    live('settings-terminal-logs-status'),
    live('settings-terminal-logs-delete'),
    { key: 'message_search', type: 'heading', id: 'settings-message-search-title', label: 'Board message search', help: { text: 'An index that makes a search of board messages faster.', more: 'On by default. It takes disk, about 0.6 times the text of the messages, and is built in the background after Coral starts: a search reads every message until it is ready. To turn it off, start Coral with CORAL_BOARD_SEARCH_INDEX=off; the index is then dropped.' } },
    live('settings-message-search-status'),
    { key: 'worktrees', type: 'heading', id: 'wt-title', label: 'Kept worktrees', help: { text: 'Kept because they still hold your work.', more: 'Git worktrees Coral made for teams and jobs and kept when they stopped. Remove one when you no longer need it: Coral never forces a removal, so unsaved changes or unmerged commits keep it.' } },
    { key: 'worktrees_list', type: 'notice', render: slot => { slot.id = 'settings-worktrees-row'; const el = document.getElementById('settings-worktrees-live'); if (el) slot.append(el); } },
];

// The API key's line (#8460): the key (masked, read only; security_settings.js and settings_machine.js fill it) with Show, Copy and the Mobile QR beside it (under it where the panel is narrow). Drawn here, with the component's own line class.
const apiKeyLine = slot => {
    const mk = (tag, cls, attrs = {}, text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
    const line = mk('div', 'sv-ctl-line', { id: 'settings-api-key-live' });
    const input = mk('input', 'field field-dense sv-input settings-mono-input', { type: 'password', id: 'settings-api-key', readonly: '', autocomplete: 'off', placeholder: 'Loading...', 'aria-label': 'API key' });
    const show = mk('button', 'btn btn-small settings-copy-btn', { type: 'button', id: 'settings-api-key-show', 'aria-pressed': 'false' }, 'Show'); show.hidden = true;
    const copy = mk('button', 'btn btn-small settings-copy-btn', { type: 'button', id: 'settings-api-key-copy' }, 'Copy'); copy.disabled = true;
    const qr = mk('button', 'btn btn-small', { type: 'button', title: 'Show QR code for mobile connection' });
    qr.setAttribute('data-on-click', 'm-show-mobile-connect-modal');
    const icon = mk('span', 'material-icons sv-ctl-icon', { 'aria-hidden': 'true' }, 'qr_code_2'); qr.append(icon, ' Mobile QR');
    line.append(input, show, copy, qr); slot.append(line);
};

export const SECURITY_FIELDS = [
    { key: 'security_access_title', type: 'heading', id: 'settings-security-access-title', label: 'Access' },
    { key: 'api_key', type: 'custom', id: 'settings-api-key-group', label: 'API key', render: slot => apiKeyLine(slot) },
    live('settings-security'),
    { key: 'security_data_title', type: 'heading', id: 'settings-security-data-title', label: 'Data and privacy' },
    { key: 'database_encryption', type: 'select', id: 'settings-database-encryption', labelId: 'settings-database-encryption-label', label: 'Database encryption', live: ['settings-database-encryption-status'], visibleWhen: () => { const e = document.getElementById('settings-database-encryption'); return !e || e.dataset.unsupported !== '1'; }, disabledWhen: () => { const e = document.getElementById('settings-database-encryption'); return !!e && e.dataset.locked === '1'; },
        help: { text: 'Applies after restart.', more: 'Coral never stores a database password in browser storage, URLs, logs, or ordinary settings.' },
        options: [{ value: 'disabled', label: 'Off (plaintext database)' }, { value: 'key_file', label: 'Local key file (~/.coral/.db_key)' }, { value: 'password', label: 'Password at startup' }] },
    { key: 'telemetry_enabled', type: 'toggle', id: 'settings-telemetry-enabled', label: 'Usage analytics', help: 'Anonymous product events only. No prompts, transcripts, or secrets are sent. Applies immediately.' },
    { key: 'install_id', type: 'custom', id: 'settings-install-id-group', label: 'Install ID', live: ['settings-telemetry-install-hint', 'settings-telemetry-install-status'], render: slot => { const el = document.getElementById('settings-telemetry-install-box'); if (el) slot.append(el); } },
    { key: 'debug_input_log', type: 'toggle', id: 'settings-debug-input-log', label: 'Log terminal input (debug)', disabledWhen: () => { const e = document.getElementById('settings-debug-input-log'); return !!e && e.dataset.locked === '1'; }, live: ['settings-debug-input-log-status', { id: 'settings-debug-input-log-delete', describes: false }], help: { text: '', more: 'Record everything Coral sends to agent terminals, for troubleshooting. Applies immediately.' } },
];

export const NETWORK_FIELDS = [
    { key: 'remote_access', type: 'toggle', id: 'settings-remote-access-enabled', labelId: 'net-access-title', label: 'Remote access', live: ['settings-remote-access-status', 'net-remote-note'],
        help: { text: 'Allow connections from other devices.', more: 'Plain HTTP (unencrypted) unless Coral was started with --tls-cert and --tls-key.' } },
    // the groups of this pane (#8491): a title drawn by settings_view (the sections are labelled by it) and the group's body, a part of the page its own module fills and shows or hides (the row and its title leave with it, settings_view.css)
    { key: 'net_setup_title', type: 'heading', id: 'net-setup-title', label: 'Setup code' }, live('net-group-setup'),
    { key: 'net_status_title', type: 'heading', id: 'net-status-title', label: 'Status' }, live('about-section'),
    { key: 'net_hub_title', type: 'heading', id: 'net-hub-title', label: 'Coral Hub' }, live('net-group-hub'),
    { key: 'hub_mode', type: 'toggle', id: 'settings-hub-mode-enabled', labelId: 'settings-hub-mode-label', label: 'Manage other computers from this one', live: ['settings-hub-mode-status', 'settings-hub-mode-restart'],
        help: { text: 'Adds a Servers tab, with full control of those computers.', more: "It uses this Coral's own address, port and sign-in: the API key from other computers, and Remote access above for who can reach it. Nothing new listens. Turning it off keeps the servers you added." } },
];

/** Draws the groups that are fields into the Settings modal's panes (once, when the modal is built). mount is mountSettingsView. */
export function drawSettingsGroups(modal, mount) {
    for (const [hostId, fields] of [['settings-general-rows', GENERAL_FIELDS], ['settings-notifications-rows', NOTIFICATIONS_FIELDS], ['settings-files-rows', FILES_FIELDS], ['settings-terminal-rows', TERMINAL_FIELDS], ['settings-agents-rows', AGENTS_FIELDS], ['settings-cleanup-rows', CLEANUP_FIELDS], ['settings-security-rows', SECURITY_FIELDS], ['settings-network-rows', NETWORK_FIELDS]]) {
        const host = modal.querySelector(`#${hostId}`);
        if (host && !host.firstChild) mount(host, { mode: 'settings', saveBar: false, fields: typeof fields === 'function' ? fields(host) : fields });
        for (const id of hostId === 'settings-terminal-rows' ? TERMINAL_BACKEND_IDS : hostId === 'settings-agents-rows' ? ['settings-custom-models'] : []) host.querySelector(`#${id}`)?.closest('.sv-row')?.setAttribute('hidden', ''); // until the module that fills them has read its status
    }
}
