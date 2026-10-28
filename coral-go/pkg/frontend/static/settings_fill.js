/* The Settings dialog's fill: the CLI path fields and each group's rows filled from the saved settings when the dialog opens (moved out of settings_dialog.js, #8383). */
import { defaultTerminalFont } from './terminal_font.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { getEngineNames } from './renderers.js';
import { desktopNotifySupported, desktopNotifyEnabled, desktopNotifyBlocked, enableDesktopNotify, disableDesktopNotify, alertPrefs, setAlertPref } from './desktop_notify.js';
import { isCloud } from './server_base.js';
import { isPhoneLayout } from './phone_layout.js';
import { settingBool, renderRemoteAccessStatus, renderDebugInputLogStatus, renderToolsFolderStatus, defaultThemeChoice, previewTheme } from './settings_core.js';
import { browserLocal } from './safe_storage.js';
const { _fillModelDatalist, _getAgentModels } = await importOnce('./launch_models.js');
const { _updatePermModeDescription } = await importOnce('./permission_flags.js');
const { _setApiKey, _wireApiKeyControls, loadDatabaseEncryptionStatus } = await importOnce('./settings_machine.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { loadArtifactStoreSize, loadMessageSearchIndex, loadTerminalLogs, loadExamples, wireStorageActions } = await importOnce('./settings_storage.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { loadCodexTrustHooks } = await importOnce('./settings_codex_hooks.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { settingsAtOpen } = await importOnce('./settings_snapshots.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

// The CLI path fields, as the server has them now. The dialog opens at once from the settings this page loaded, which a
// CLI path saved from another tab or client has outdated: a moment later the fields the person has not touched show the
// server's value, and it becomes what Save compares with (so a path the person never edited is never written back).
export const CLI_PATH_FIELDS = { cli_path_claude: 'settings-cli-path-claude', cli_path_codex: 'settings-cli-path-codex', cli_path_pi: 'settings-cli-path-pi', cli_path_agy: 'settings-cli-path-agy' };

// The CLI path settings whose field the person typed in since the dialog opened.
export function editedCLIPathKeys() {
    return Object.entries(CLI_PATH_FIELDS).filter(([, id]) => document.getElementById(id)?.dataset.edited === '1').map(([key]) => key);
}

// dropUnfilledCLIPaths removes from payload the CLI path settings whose field the dialog has not filled and the person has not
// typed in: an empty field that was never filled is not a path cleared on purpose (it would clear the path, v1.4.80 gate).
export function dropUnfilledCLIPaths(payload) {
    for (const [key, id] of Object.entries(CLI_PATH_FIELDS)) {
        const el = document.getElementById(id);
        if (!el || el.dataset.filled === '1' || el.dataset.edited === '1') continue;
        delete payload[key];
        if (key === 'cli_path_agy') delete payload.cli_path_gemini; // one field for both
    }
    return payload;
}

function refreshCLIPathFields() {
    if (isCloud()) return; // the CLI path fields are hidden on the hub (machine settings): nothing to refresh
    const { cli_path_agy: _agy, ...fields } = CLI_PATH_FIELDS;
    const opened = settingsAtOpen();
    const ids = [...Object.values(fields), 'settings-cli-path-agy'];
    // Typing in a field marks it edited, even when what is typed equals what it showed.
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.dataset.edited = '';
        if (!el.dataset.watched) { el.dataset.watched = '1'; el.addEventListener('input', () => { el.dataset.edited = '1'; }); }
    }
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(data => {
        const fresh = data && data.settings;
        // A different open since (the dialog was closed and opened again) has its own refresh.
        if (!fresh || settingsAtOpen() !== opened) return;
        const update = {};
        for (const [key, id] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (!el || el.dataset.edited === '1') continue; // the person is editing it: leave it
            const now = fresh[key] || '';
            el.value = now;
            update[key] = now;
        }
        const agy = document.getElementById('settings-cli-path-agy');
        if (agy && agy.dataset.edited !== '1') {
            const now = fresh.cli_path_agy || fresh.cli_path_gemini || '';
            agy.value = now;
            update.cli_path_agy = fresh.cli_path_agy || '';
            update.cli_path_gemini = fresh.cli_path_gemini || '';
        }
        Object.assign(settingsAtOpen(), update);
        state.settings = { ...state.settings, ...update };
    }).catch(() => { /* the dialog keeps what it opened with */ });
}

// The machine-only parts of the dialog (privacy, remote access, storage, database encryption, the hub connection); the hub's dialog has none of them.
export async function _fillMachineSettings(s) {
    if (!isCloud()) {
        const telemetry = document.getElementById('settings-telemetry-enabled');
        if (telemetry) telemetry.checked = settingBool(s.telemetry_enabled, true);
        loadArtifactStoreSize({ fresh: true }); // the store's size next to its limit (#3553)
        loadTerminalLogs(); // the terminal logs of ended agents (#4447)
        loadExamples(); // the example job and workflow, with a Remove (#10001)
        loadMessageSearchIndex(); // the board message search index: its setting, state and size (#9685)
        wireStorageActions(); // free space and automatic cleanup (#3554)
        const autoAttach = document.getElementById('settings-board-auto-attach');
        // Off unless the Operator turned it on (#3563); an empty value is unset.
        if (autoAttach) autoAttach.checked = settingBool(s.board_auto_attach || undefined, false);
        loadCodexTrustHooks(); // its own local route, saved when it changes (#153)
        const nudgeArtifacts = document.getElementById('settings-nudge-claude-artifacts');
        // On unless the Operator turned it off (#6583); an empty value is unset.
        if (nudgeArtifacts) nudgeArtifacts.checked = settingBool(s.nudge_claude_artifacts || undefined, true);
        const healthMonitor = document.getElementById('settings-board-health-monitor');
        // On unless the Operator turned it off (#5128).
        if (healthMonitor) healthMonitor.checked = settingBool(s.board_health_monitor || undefined, true);
        const autoResume = document.getElementById('settings-auto-resume');
        // Off unless the Operator turned it on (#3613).
        if (autoResume) autoResume.checked = settingBool(s.auto_resume_after_api_error || undefined, false);
        const autoGoals = document.getElementById('settings-auto-goals');
        // On unless the Operator turned it off (#4204).
        if (autoGoals) autoGoals.checked = settingBool(s.auto_goals || undefined, true);
        const debugInput = document.getElementById('settings-debug-input-log');
        if (debugInput) debugInput.checked = settingBool(s.debug_input_log, false);
        const remote = document.getElementById('settings-remote-access-enabled');
        if (remote) remote.checked = settingBool(s.remote_access_enabled, false);
        renderRemoteAccessStatus(state.privacyStatus);
        try {
            const privacyResp = await fetch('/api/system/privacy');
            if (!privacyResp.ok) throw new Error(`privacy status ${privacyResp.status}`);
            state.privacyStatus = await privacyResp.json();
            if (remote) remote.checked = settingBool(state.privacyStatus.remote_access_enabled, false);
            renderRemoteAccessStatus(state.privacyStatus);
            renderDebugInputLogStatus(state.privacyStatus);
            renderToolsFolderStatus(state.privacyStatus);
        } catch (_) {
            renderRemoteAccessStatus(state.privacyStatus, !state.privacyStatus);
        }
        // Bootstrap database-encryption metadata lives outside the locked DB. The
        // endpoint returns status only; passwords/keys are never sent to the UI.
        loadDatabaseEncryptionStatus();
        // Loaded with the dialog, through importOnce so a failed load is retried (#3140).
        importOnce('./cloud_connect.js').then(m => { m.initCloudConnect(); m.loadCloudStatus(); }).catch(() => {});
        importOnce('./hub_mode_setting.js').then(m => m.loadHubModeSetting()).catch(() => {});
        importOnce('./setup_code_setting.js').then(m => m.initSetupCode()).catch(() => {}); // read only while Network and Hub is the pane in view (#6410)
    }
}

// The theme list: the built-in themes, then the saved custom ones.
export async function _fillThemeSelect(s) {
    // Theme — populate with built-in options + saved custom themes
    const themeSelect = document.getElementById("settings-theme");
    if (themeSelect) {
        // Fetch saved custom themes
        let customThemes = [];
        try {
            const resp = await fetch("/api/themes");
            const data = await resp.json();
            customThemes = data.themes || [];
        } catch (_) {}

        // Build options: built-in first, then custom
        let options = `<option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>`;
        if (customThemes.length > 0) {
            options += `<option disabled>──────────</option>`;
            for (const t of customThemes) {
                const name = escapeAttr(t.name);
                const label = escapeHtml(t.name);
                options += `<option value="custom:${escapeAttr(name)}">${label}</option>`;
            }
        }
        themeSelect.innerHTML = options;

        // Set current value
        const currentTheme = s.custom_theme ? `custom:${s.custom_theme}` : (s.theme || defaultThemeChoice()); // nothing stored shows what the page follows, never a theme that was not picked (#6114)
        themeSelect.value = currentTheme;
        if (!themeSelect.dataset.previewWired) { themeSelect.dataset.previewWired = '1'; themeSelect.addEventListener('change', () => previewTheme(themeSelect.value)); } // the page follows the choice at once (#10481)
    }
}

// The defaults for a new agent: render engine, agent type, permission mode and working directory.
export function _fillDefaults(s) {
    // Default Render Engine
    const currentEngine = s.default_renderer || "xterm";
    const options = getEngineNames()
        .map(name => `<option value="${escapeAttr(name)}"${name === currentEngine ? " selected" : ""}>${escapeHtml(name)}</option>`)
        .join("");
    document.getElementById("settings-renderer-select").innerHTML = options;

    // Default Agent Type
    const currentAgentType = s.default_agent_type || "claude";
    const agentTypeSelect = document.getElementById("settings-agent-type");
    if (agentTypeSelect) agentTypeSelect.value = currentAgentType;

    // Default Permission Mode
    const permModeSelect = document.getElementById("settings-permission-mode");
    if (permModeSelect) {
        // Nothing saved: the first option, "Not set (Auto)", is chosen (Claude starts in Auto, #5836), and picking Auto is then a real change that is saved (#7620). Once a mode is saved that option is not offered: a saved mode is not cleared from here.
        const notSet = [...permModeSelect.options].find(o => o.value === '');
        if (s.default_permission_mode) { notSet?.remove(); permModeSelect.value = s.default_permission_mode; }
        else { if (!notSet) permModeSelect.prepend(new Option('Not set (Auto)', '')); permModeSelect.value = ''; }
        _updatePermModeDescription(permModeSelect, !s.default_permission_mode);
        // A pick is a choice even when it is the mode the field showed (nothing saved shows Auto): it is saved, so a person who picks Auto and saves has Auto saved (#7620)
        permModeSelect.dataset.edited = '';
        if (!permModeSelect.dataset.watched) { permModeSelect.dataset.watched = '1'; permModeSelect.addEventListener('change', () => { permModeSelect.dataset.edited = '1'; }); }
    }

    // Default Working Directory
    const dirInput = document.getElementById("settings-working-dir");
    if (dirInput) {
        dirInput.value = s.default_working_dir || "";
        dirInput.placeholder = dirInput.dataset.coralRoot || "/path/to/project";
    }
}

// The API key box (local only), read from the server.
export function _fillApiKey() {
    // API Key
    const apiKeyInput = document.getElementById("settings-api-key");
    if (apiKeyInput && !isCloud()) {
        _wireApiKeyControls(apiKeyInput);
        fetch('/api/system/api-key').then(r => {
            // No sign-in (the dashboard opened without one, local sign-in off): the server refuses the key. Say how to see it, not "Not configured".
            if (r.status === 401 || r.status === 403) return { signIn: true };
            return r.ok ? r.json() : null;
        }).then(data => {
            _setApiKey(apiKeyInput, data && data.key, data && data.signIn ? 'Sign in to see the API key (run: coral open)' : 'Not configured');
        }).catch(() => _setApiKey(apiKeyInput, '', 'Not available'));
    }
}

/** The CLI paths are the way out of "command not found": when Coral cannot find the default agent's CLI the disclosure is already open, with the fields on screen (#7041). Silent on any failure. */
function openCliPathsWhenMissing(type) {
    const details = document.querySelector('#settings-modal #settings-cli-paths');
    if (!details || details.open) return;
    fetch(`/api/system/cli-check?type=${encodeURIComponent(type)}`).then(r => r.ok ? r.json() : null).then(d => {
        if (!d || typeof d.found !== 'boolean') return;
        if (!d.found) details.open = true;
        const sum = details.querySelector(':scope > summary'); if (!sum) return;
        const name = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', gemini: 'Antigravity', pi: 'Pi' }[type] || type;
        let note = sum.querySelector('.sv-fold-note'); if (!note) { note = document.createElement('span'); note.className = 'sv-fold-note'; sum.append(note); }
        note.textContent = ` · ${name} ${d.found ? 'found' : 'not found'}`; // the closed row says it, so nobody has to open it to know (#9955)
    }).catch(() => {});
}

// The CLI paths and the default models (and their datalists, from the model catalog; not on the hub).
export function _fillCliAndModels(s) {
    // CLI paths
    const cliClaude = document.getElementById("settings-cli-path-claude");
    const cliCodex = document.getElementById("settings-cli-path-codex");
    const cliAgy = document.getElementById("settings-cli-path-agy");
    const cliPi = document.getElementById("settings-cli-path-pi");
    if (cliClaude) cliClaude.value = s.cli_path_claude || "";
    if (cliCodex) cliCodex.value = s.cli_path_codex || "";
    const agyCliPath = s.cli_path_agy || s.cli_path_gemini || "";
    if (cliAgy) cliAgy.value = agyCliPath;
    if (cliPi) cliPi.value = s.cli_path_pi || "";
    for (const id of Object.values(CLI_PATH_FIELDS)) { const el = document.getElementById(id); if (el) el.dataset.filled = '1'; }
    refreshCLIPathFields();
    openCliPathsWhenMissing(s.default_agent_type || 'claude');

    // Default Models — populate combo inputs + datalists from /api/agent-models
    const defClaude = document.getElementById("settings-default-model-claude");
    const defCodex = document.getElementById("settings-default-model-codex");
    const defAgy = document.getElementById("settings-default-model-agy");
    const defPi = document.getElementById("settings-default-model-pi");
    if (defClaude) defClaude.value = s.default_model_claude || "";
    const defThinkingClaude = document.getElementById("settings-default-thinking-claude");
    if (defThinkingClaude) defThinkingClaude.value = s.default_thinking_claude || "";
    if (defCodex) defCodex.value = s.default_model_codex || "";
    const agyModel = s.default_model_agy || s.default_model_gemini || "";
    if (defAgy) defAgy.value = agyModel;
    if (defPi) defPi.value = s.default_model_pi || "";
    const picks = () => importOnce('./settings_model_pick.js').then(m => m.syncModelPicks()).catch(() => {}); // each box is a dropdown of the models with Other… behind it (#10000)
    picks();
    // On the hub the Default Models rows are hidden (machine settings), and the hub has no model catalog of its own to ask.
    if (!isCloud()) importOnce('./custom_models.js').then(m => m.initCustomModels()).catch(() => {}); // the custom models list (#5480): hidden when this server has no such route
    if (!isCloud()) _getAgentModels().then(models => {
        // _getAgentModels swallows errors and resolves with {} on failure; on
        // success it returns the canonical map with an array for each agent type.
        if (!models || !Array.isArray(models.claude)) {
            const notice = document.getElementById("settings-default-models-notice");
            if (notice) notice.textContent = "Could not load model list — you can still type a custom model id.";
            picks();
            return;
        }
        _fillModelDatalist(document.getElementById("settings-models-claude"), "claude", models);
        _fillModelDatalist(document.getElementById("settings-models-codex"), "codex", models);
        _fillModelDatalist(document.getElementById("settings-models-agy"), "agy", models);
        _fillModelDatalist(document.getElementById("settings-models-pi"), "pi", models);
        picks();
    });
}

// Grouping, terminal font and scrollback, notifications, update check and scrollbars.
export function _fillTerminalAndBrowserPrefs(s) {
    // Group by Team
    const groupByTeamCheck = document.getElementById("settings-group-by-team");
    if (groupByTeamCheck) {
        groupByTeamCheck.checked = browserLocal.get('coral-group-by-team') !== 'false';
    }

    // Terminal Font Size
    const fontSizeSelect = document.getElementById("settings-terminal-font-size");
    if (fontSizeSelect) fontSizeSelect.value = s.terminal_font_size || String(defaultTerminalFont()); // what is drawn when nothing is chosen: a phone's is smaller (#6577)

    // Terminal Scrollback
    const scrollbackSelect = document.getElementById("settings-terminal-scrollback");
    if (scrollbackSelect) scrollbackSelect.value = s.terminal_scrollback || "20000";

    // Fit Pane Width
    const fitPaneCheck = document.getElementById("settings-fit-pane-width");
    if (fitPaneCheck) fitPaneCheck.checked = !!s.fit_pane_width;

    // Notify Needs Input
    const notifyCheck = document.getElementById("settings-notify-needs-input");
    if (notifyCheck) notifyCheck.checked = !!s.notify_needs_input;

    // Desktop alerts: a per-browser opt-in, never sent to the server. What the person may do when it cannot turn on is said under it, never a silent snap back (#10068).
    const desktopCheck = document.getElementById("settings-desktop-notify");
    const why = document.getElementById("settings-desktop-blocked");
    const kinds = [["settings-alert-needs-input", "needsInput"], ["settings-alert-reply", "finished"], ["settings-alert-sound", "sound"]];
    const paintAlertKinds = () => {
        const on = desktopNotifyEnabled(), prefs = alertPrefs();
        for (const [id, name] of kinds) {
            const box = document.getElementById(id);
            if (!box) continue;
            box.checked = !!prefs[name];
            box.disabled = !on;
            if (!box.dataset.bound) {
                box.dataset.bound = "1";
                box.addEventListener("change", () => setAlertPref(name, box.checked));
            }
        }
    };
    const say = text => { if (why) { why.textContent = text; why.hidden = !text; } };
    const blockedText = () => desktopNotifyBlocked()
        ? `Your browser blocks alerts from Coral. Allow notifications for this site in ${isPhoneLayout() ? "your browser's site settings" : "the browser's address bar or site settings"}, then turn this on again.` // a phone has no address bar to look at (#10266)
        : "";
    if (desktopCheck) {
        desktopCheck.checked = desktopNotifyEnabled();
        desktopCheck.disabled = !desktopNotifySupported();
        say(desktopNotifySupported() ? blockedText() : "This browser has no desktop alerts.");
        paintAlertKinds();
        if (!desktopCheck.dataset.bound) {
            desktopCheck.dataset.bound = "1";
            desktopCheck.addEventListener("change", async () => {
                if (desktopCheck.checked) {
                    desktopCheck.checked = await enableDesktopNotify();
                    say(desktopCheck.checked ? "" : (blockedText() || "Alerts need your permission: choose Allow when the browser asks, then turn this on again."));
                } else {
                    disableDesktopNotify();
                    say("");
                }
                paintAlertKinds();
            });
        }
    }

    // Check for Updates (stored in localStorage, defaults to on)
    const updateCheck = document.getElementById("settings-check-updates");
    if (updateCheck) updateCheck.checked = browserLocal.get("coral-update-check-enabled") !== "false";

    // Show Scrollbars (defaults to true)
    const scrollbarsCheck = document.getElementById("settings-show-scrollbars");
    if (scrollbarsCheck) scrollbarsCheck.checked = s.show_scrollbars !== false;
}

// File search, git diff base and scan interval, agent priority.
export function _fillFilesAndGit(s) {
    // File Search Mode (defaults to 'directory')
    const fileSearchSelect = document.getElementById("settings-file-search-mode");
    if (fileSearchSelect) fileSearchSelect.value = s.file_search_mode || 'directory';
    const fileSearchLimitSelect = document.getElementById("settings-file-search-limit");
    if (fileSearchLimitSelect) fileSearchLimitSelect.value = s.file_search_limit || "500";

    // Git Diff Mode (defaults to 'previous_commit')
    const gitDiffSelect = document.getElementById("settings-git-diff-mode");
    if (gitDiffSelect) gitDiffSelect.value = s.git_diff_mode || 'previous_commit';

    // Git scan interval, in seconds; "0" means the user scans manually.
    const gitPollSelect = document.getElementById("settings-git-poll-interval");
    if (gitPollSelect) {
        const secs = String(s.git_poll_interval_s ?? '120');
        // An interval set outside the presets (by hand, or by an older build)
        // still needs to show as itself rather than silently snapping.
        if (!Array.from(gitPollSelect.options).some(o => o.value === secs)) {
            const opt = new Option(`Every ${secs} seconds`, secs);
            gitPollSelect.add(opt);
        }
        gitPollSelect.value = secs;
    }

    // Run agents at lower priority (#3437, a checkbox since #3712): on unless set to normal.
    const agentLowPriority = document.getElementById("settings-agent-low-priority");
    if (agentLowPriority) agentLowPriority.checked = s.agent_priority !== 'normal';
}
