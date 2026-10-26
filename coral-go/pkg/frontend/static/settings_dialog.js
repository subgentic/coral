/* Moved out of modals.js as it was (#4684): The Settings dialog: its sections, the API key, storage, database encryption, filling and saving it. No behaviour change. */
import { defaultTerminalFont, terminalFontFor } from './terminal_font.js';
import { importOnce } from './import_once.js';
import { updatesUiOn } from './update_flag.js';
import { state } from './state.js';
import { showToast, escapeHtml, escapeAttr } from './utils.js';
import { refreshChangedFiles } from './changed_files.js';
import { getEngineNames } from './renderers.js';
import { renderCaptureText, syncPaneWidth } from './capture.js';
import { getTerminal } from './xterm_renderer.js';
import { desktopNotifySupported, desktopNotifyEnabled, enableDesktopNotify, disableDesktopNotify } from './desktop_notify.js';
import { applyCloudSettingsDialog, filterSettingsPayload } from './cloud_settings.js';
import { isCloud } from './server_base.js';
import { NOTHING_TO_SAVE } from './settings_diff.js';
import { settingBool, changedSettings, savedWords, renderRemoteAccessStatus, renderDebugInputLogStatus, renderToolsFolderStatus, applyTheme, clearCustomThemeVars, applyCustomThemeByName, defaultThemeChoice } from './settings_core.js';
import { attachDialogFocus } from './dialog_focus.js';
import { browserLocal } from './safe_storage.js';
import { openSettingsGroup } from './settings_nav.js';
const { _fillModelDatalist, _getAgentModels, _invalidateAgentModels, _invalidateDefaultModels } = await importOnce('./launch_models.js');
const { _updatePermModeDescription } = await importOnce('./permission_flags.js');
import { settingsRowsReady } from './settings_rows_boot.js';
const { _setApiKey, _wireApiKeyControls, loadTelemetryInstallID, loadDatabaseEncryptionStatus, databaseEncryptionChanged, saveDatabaseEncryptionSettings } = await importOnce('./settings_machine.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { loadArtifactStoreSize, loadTerminalLogs, wireStorageActions, retentionSettings, receivedMaxSetting, artifactStoreMaxSetting } = await importOnce('./settings_storage.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { loadCodexTrustHooks } = await importOnce('./settings_codex_hooks.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)


// ── Settings Modal ────────────────────────────────────────────────────────


// ── Theme ────────────────────────────────────────────────────────────────


// The settings the dialog opened with: Save sends only the fields that differ from them (settings_diff.js).
let _settingsAtOpen = null;

// The CLI path fields, as the server has them now. The dialog opens at once from the settings this page loaded, which a
// CLI path saved from another tab or client has outdated: a moment later the fields the person has not touched show the
// server's value, and it becomes what Save compares with (so a path the person never edited is never written back).
const CLI_PATH_FIELDS = { cli_path_claude: 'settings-cli-path-claude', cli_path_codex: 'settings-cli-path-codex', cli_path_pi: 'settings-cli-path-pi', cli_path_agy: 'settings-cli-path-agy' };

// The CLI path settings whose field the person typed in since the dialog opened.
function editedCLIPathKeys() {
    return Object.entries(CLI_PATH_FIELDS).filter(([, id]) => document.getElementById(id)?.dataset.edited === '1').map(([key]) => key);
}

// dropUnfilledCLIPaths removes from payload the CLI path settings whose field the dialog has not filled and the person has not
// typed in: an empty field that was never filled is not a path cleared on purpose (it would clear the path, v1.4.80 gate).
function dropUnfilledCLIPaths(payload) {
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
    const opened = _settingsAtOpen;
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
        if (!fresh || _settingsAtOpen !== opened) return;
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
        Object.assign(_settingsAtOpen, update);
        state.settings = { ...state.settings, ...update };
    }).catch(() => { /* the dialog keeps what it opened with */ });
}

// The machine-only parts of the dialog (privacy, remote access, storage, database encryption, the hub connection); the hub's dialog has none of them.
async function _fillMachineSettings(s) {
    if (!isCloud()) {
        const telemetry = document.getElementById('settings-telemetry-enabled');
        if (telemetry) telemetry.checked = settingBool(s.telemetry_enabled, true);
        loadArtifactStoreSize({ fresh: true }); // the store's size next to its limit (#3553)
        loadTerminalLogs(); // the terminal logs of ended agents (#4447)
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
async function _fillThemeSelect(s) {
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
    }
}

// The defaults for a new agent: render engine, agent type, permission mode and working directory.
function _fillDefaults(s) {
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
function _fillApiKey() {
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
    const details = document.querySelector('#settings-modal .settings-cli-details');
    if (!details || details.open) return;
    fetch(`/api/system/cli-check?type=${encodeURIComponent(type)}`).then(r => r.ok ? r.json() : null).then(d => { if (d && d.found === false) details.open = true; }).catch(() => {});
}

// The CLI paths and the default models (and their datalists, from the model catalog; not on the hub).
function _fillCliAndModels(s) {
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
    // On the hub the Default Models rows are hidden (machine settings), and the hub has no model catalog of its own to ask.
    if (!isCloud()) importOnce('./custom_models.js').then(m => m.initCustomModels()).catch(() => {}); // the custom models list (#5480): hidden when this server has no such route
    if (!isCloud()) _getAgentModels().then(models => {
        // _getAgentModels swallows errors and resolves with {} on failure; on
        // success it returns the canonical map with an array for each agent type.
        if (!models || !Array.isArray(models.claude)) {
            const notice = document.getElementById("settings-default-models-notice");
            if (notice) notice.textContent = "Could not load model list — you can still type a custom model id.";
            return;
        }
        _fillModelDatalist(document.getElementById("settings-models-claude"), "claude", models);
        _fillModelDatalist(document.getElementById("settings-models-codex"), "codex", models);
        _fillModelDatalist(document.getElementById("settings-models-agy"), "agy", models);
        _fillModelDatalist(document.getElementById("settings-models-pi"), "pi", models);
    });
}

// Grouping, terminal font and scrollback, notifications, update check and scrollbars.
function _fillTerminalAndBrowserPrefs(s) {
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

    // Desktop alerts: a per-browser opt-in, never sent to the server
    const desktopCheck = document.getElementById("settings-desktop-notify");
    if (desktopCheck) {
        desktopCheck.checked = desktopNotifyEnabled();
        desktopCheck.disabled = !desktopNotifySupported();
        if (!desktopCheck.dataset.bound) {
            desktopCheck.dataset.bound = "1";
            desktopCheck.addEventListener("change", async () => {
                if (desktopCheck.checked) desktopCheck.checked = await enableDesktopNotify();
                else disableDesktopNotify();
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
function _fillFilesAndGit(s) {
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

/** The "Unsaved changes" note in Settings' footer (UI audit #5589, finding 27): shown while the form differs from what it held when it finished opening (or was last saved), or a database encryption or terminal backend or wake choice is pending. The baseline is the form's own payload, not the saved settings: a new install has no saved settings, so everything would differ. Changes to the custom models and the update switches are saved too but are not counted here. */
let _formAtOpen = null;
let _payloadAtOpen = null; // the same snapshot as an object: the Save toast names only the rows that differ from it (a first Save also writes defaults the person never touched, #7041)
const formKey = () => { try { return JSON.stringify(readSettingsForm().payload); } catch { return null; } };
const payloadNow = () => { try { return readSettingsForm().payload; } catch { return null; } };
/** The part of a saved payload the person changed since the dialog opened (or was last saved). */
const changedSince = payload => Object.fromEntries(Object.entries(payload).filter(([k, v]) => !_payloadAtOpen || JSON.stringify(_payloadAtOpen[k]) !== JSON.stringify(v)));
async function refreshUnsavedNote() {
    const note = document.getElementById('settings-unsaved');
    if (!note) return;
    let dirty = _formAtOpen !== null && formKey() !== _formAtOpen;
    if (!dirty && _formAtOpen !== null) { dirty = databaseEncryptionChanged(); }
    if (!dirty && _formAtOpen !== null) { try { dirty = await importOnce('./terminal_backend.js').then(tb => tb.hasUnsavedBackendChange(), () => false); } catch { dirty = false; } }
    if (note.hidden === dirty) note.hidden = !dirty;
    // A note, not a live region (#6656): while there are unsaved changes the Save button is described by it, so it is read when the person reaches Save, where it matters, and not announced on every edit.
    const save = document.getElementById('settings-save-btn');
    if (save) { if (dirty) { if (save.getAttribute('aria-describedby') !== 'settings-unsaved') save.setAttribute('aria-describedby', 'settings-unsaved'); } else if (save.hasAttribute('aria-describedby')) save.removeAttribute('aria-describedby'); }
}

export async function showSettingsModal(group) {
    await settingsRowsReady(); // the dialog's rows that are fields (settings_fields.js) are in the page before anything reads them by id
    // Focus moves in on open, Tab stays inside, and focus comes back on close (accessibility pass).
    attachDialogFocus(document.getElementById('settings-modal'));
    importOnce('./quiet_focus.js').then(m => m.quietFocus(document.getElementById('settings-modal')), () => {}); // the open tab takes the focus by script: no ring for a pointer's start, the ring for a key press (#7405, as #7391's New Agent)

    importOnce('./terminal_backend.js').then(m => m.loadTerminalBackendRow()).catch(() => {}); // #3634
    importOnce('./worktrees_panel.js').then(m => m.loadWorktrees()).catch(() => {}); // the kept worktrees, in Storage and cleanup (#6743)
    importOnce('./security_settings.js').then(m => m.loadSecurityRow()).catch(() => {}); // #3948
    const s = state.settings || {};
    // What this dialog opens with: Save sends only the fields that end up different from it.
    _settingsAtOpen = { ...s };
    // The CLI path fields are filled later in this function (after awaited requests): until then they are empty, and a Save
    // made in that time (a suite that does not wait for the dialog) must not read them as "cleared".
    for (const id of Object.values(CLI_PATH_FIELDS)) { const el = document.getElementById(id); if (el) el.dataset.filled = ''; }
    // The machine-only parts of this dialog (privacy, remote access, database encryption, connecting to a hub) do not
    // exist on the hub: the cloud dialog shows only the per-user settings (applyCloudSettingsDialog below).
    await _fillMachineSettings(s);

    await _fillThemeSelect(s);

    _fillDefaults(s);

    _fillApiKey();

    await loadTelemetryInstallID();

    _fillCliAndModels(s);

    _fillTerminalAndBrowserPrefs(s);

    _fillFilesAndGit(s);

    // A partner build's name (Coral has no paid licence, #3221)
    if (!isCloud()) _loadTierBranding();

    // App version
    fetch('/api/system/status').then(r => r.json()).then(d => {
        const el = document.getElementById('app-version-label');
        if (el && d.version) el.textContent = 'Version ' + d.version;
    }).catch(() => {});

    if (isCloud()) applyCloudSettingsDialog();

    openSettingsGroup(typeof group === 'string' ? group : undefined); // the group last used here, or the one asked for
    const modalEl = document.getElementById('settings-modal');
    if (!modalEl._unsavedWired) { modalEl._unsavedWired = true; for (const type of ['input', 'change']) modalEl.addEventListener(type, () => { refreshUnsavedNote(); }); }
    _formAtOpen = formKey(); // the form as it finished opening
    _payloadAtOpen = payloadNow();
    refreshUnsavedNote();
    document.getElementById("settings-modal").style.display = "flex";
}

async function _loadTierBranding() {
    try {
        const resp = await fetch('/api/system/status');
        if (!resp.ok) return;
        const data = await resp.json();
        const branding = document.getElementById('tier-branding-label');
        if (branding && data.tier_name === 'dropboxers') {
            branding.textContent = 'Coral For Dropbox';
            branding.style.display = '';
        }
    } catch { /* non-critical */ }
}

export function hideSettingsModal() {
    document.getElementById("settings-modal").style.display = "none";
    if (!isCloud()) importOnce('./custom_models.js').then(m => m.discardCustomModels()).catch(() => {}); // unsaved custom models are dropped with the dialog (#5480)
}

/** What the dialog's controls hold: the payload to save (only what the person changed, and on the hub only the per-user keys) and the values the page applies once it is saved. */
function readSettingsForm() {
    const themeValue = document.getElementById("settings-theme")?.value || "dark";
    const engineName = document.getElementById("settings-renderer-select").value;
    const agentType = document.getElementById("settings-agent-type")?.value || "claude";
    const permissionMode = document.getElementById("settings-permission-mode")?.value || "auto";
    const workingDir = document.getElementById("settings-working-dir")?.value.trim() || "";
    const cliPathClaude = document.getElementById("settings-cli-path-claude")?.value.trim() || "";
    const cliPathCodex = document.getElementById("settings-cli-path-codex")?.value.trim() || "";
    const cliPathAgy = document.getElementById("settings-cli-path-agy")?.value.trim() || "";
    const cliPathPi = document.getElementById("settings-cli-path-pi")?.value.trim() || "";
    const defaultModelClaude = document.getElementById("settings-default-model-claude")?.value.trim() || "";
    const defaultThinkingClaude = document.getElementById("settings-default-thinking-claude")?.value || "";
    const defaultModelCodex = document.getElementById("settings-default-model-codex")?.value.trim() || "";
    const defaultModelAgy = document.getElementById("settings-default-model-agy")?.value.trim() || "";
    const defaultModelPi = document.getElementById("settings-default-model-pi")?.value.trim() || "";
    const fitPaneWidth = document.getElementById("settings-fit-pane-width")?.checked || false;
    const notifyNeedsInput = document.getElementById("settings-notify-needs-input")?.checked || false;
    const terminalFontSize = document.getElementById("settings-terminal-font-size")?.value || String(defaultTerminalFont());
    const terminalScrollback = document.getElementById("settings-terminal-scrollback")?.value || "20000";
    const checkUpdates = document.getElementById("settings-check-updates")?.checked ?? true;
    const showScrollbars = document.getElementById("settings-show-scrollbars")?.checked ?? true;
    const fileSearchMode = document.getElementById("settings-file-search-mode")?.value || "directory";
    const fileSearchLimit = document.getElementById("settings-file-search-limit")?.value || "500";
    const gitDiffMode = document.getElementById("settings-git-diff-mode")?.value || "branch_point";
    const gitPollIntervalS = document.getElementById("settings-git-poll-interval")?.value ?? "120";
    // The server takes only "low" or "normal" (#3470): a value stored before that check is sent as low.
    const lowBox = document.getElementById("settings-agent-low-priority");
    const agentPriority = lowBox ? (lowBox.checked ? "low" : "normal") : (state.settings?.agent_priority === "normal" ? "normal" : "low");
    const telemetryEnabled = document.getElementById("settings-telemetry-enabled")?.checked ?? settingBool(state.settings?.telemetry_enabled, true);
    const boardAutoAttach = document.getElementById("settings-board-auto-attach")?.checked ?? settingBool(state.settings?.board_auto_attach || undefined, false);
    const nudgeClaudeArtifacts = document.getElementById("settings-nudge-claude-artifacts")?.checked ?? settingBool(state.settings?.nudge_claude_artifacts || undefined, true);
    const boardHealthMonitor = document.getElementById("settings-board-health-monitor")?.checked ?? settingBool(state.settings?.board_health_monitor || undefined, true);
    const autoResume = document.getElementById("settings-auto-resume")?.checked ?? settingBool(state.settings?.auto_resume_after_api_error || undefined, false);
    const autoGoals = document.getElementById("settings-auto-goals")?.checked ?? settingBool(state.settings?.auto_goals || undefined, true);
    // When CORAL_DEBUG_INPUT/--debug-input force the log on, the checkbox is shown checked and
    // disabled: keep the saved setting rather than saving that forced state (#3256).
    const debugInputBox = document.getElementById("settings-debug-input-log");
    const debugInputLog = debugInputBox && !debugInputBox.disabled ? debugInputBox.checked : settingBool(state.settings?.debug_input_log, false);
    const remoteAccessEnabled = document.getElementById("settings-remote-access-enabled")?.checked ?? settingBool(state.settings?.remote_access_enabled, false);

    // Parse theme selection — "custom:<name>" or built-in "dark"/"light"/"system"
    let theme, customTheme;
    if (themeValue.startsWith("custom:")) {
        customTheme = themeValue.slice(7);
        theme = "dark"; // will be overridden by the custom theme's base
    } else {
        theme = themeValue;
        customTheme = "";
    }

    let payload = {
        theme: theme,
        custom_theme: customTheme,
        default_renderer: engineName,
        default_agent_type: agentType,
        default_permission_mode: permissionMode,
        default_working_dir: workingDir,
        fit_pane_width: fitPaneWidth,
        notify_needs_input: notifyNeedsInput,
        terminal_font_size: terminalFontSize,
        terminal_scrollback: terminalScrollback,
        show_scrollbars: showScrollbars,
        cli_path_claude: cliPathClaude,
        cli_path_codex: cliPathCodex,
        cli_path_agy: cliPathAgy,
        cli_path_gemini: cliPathAgy,
        cli_path_pi: cliPathPi,
        default_model_claude: defaultModelClaude,
        default_thinking_claude: defaultThinkingClaude,
        default_model_codex: defaultModelCodex,
        default_model_agy: defaultModelAgy,
        default_model_gemini: defaultModelAgy,
        default_model_pi: defaultModelPi,
        file_search_mode: fileSearchMode,
        file_search_limit: fileSearchLimit,
        git_diff_mode: gitDiffMode,
        git_poll_interval_s: gitPollIntervalS,
        agent_priority: agentPriority,
        telemetry_enabled: telemetryEnabled,
        board_auto_attach: boardAutoAttach,
        nudge_claude_artifacts: nudgeClaudeArtifacts,
        board_health_monitor: boardHealthMonitor,
        auto_resume_after_api_error: autoResume,
        auto_goals: autoGoals,
        ...artifactStoreMaxSetting(),
        ...receivedMaxSetting(),
        ...retentionSettings(),
        debug_input_log: debugInputLog,
        remote_access_enabled: remoteAccessEnabled,
    };

    // Only what the person changed since the dialog opened: a field this dialog never touched (a CLI path another
    // tab saved meanwhile) is not written back with the value this page opened with.
    payload = changedSettings(dropUnfilledCLIPaths(payload), _settingsAtOpen, themeValue, [...editedCLIPathKeys(), ...(document.getElementById('settings-permission-mode')?.dataset.edited === '1' && document.getElementById('settings-permission-mode').value ? ['default_permission_mode'] : [])], defaultThemeChoice());
    // The hub accepts only the per-user keys (anything else refuses the whole request); the machine ones are hidden.
    if (isCloud()) payload = filterSettingsPayload(payload).kept;

    return { themeValue, themeSaved: 'theme' in payload, theme, customTheme, payload, checkUpdates, fitPaneWidth, terminalFontSize, terminalScrollback, showScrollbars, gitDiffMode, remoteAccessEnabled, debugInputLog };
}

/** Sends the payload (nothing, when nothing changed) and takes it into state.settings and the privacy status. Returns true when there was nothing to save; throws when the server refuses. */
async function saveSettings({ payload, remoteAccessEnabled, debugInputLog }) {
    // Nothing to save when no setting changed and neither the database encryption choice nor the backend and wake choices did (they are saved apart).
    const sideChange = databaseEncryptionChanged() || await importOnce('./terminal_backend.js').then(tb => tb.hasUnsavedBackendChange(), () => true);
    const nothingToSave = Object.keys(payload).length === 0 && !sideChange;
    if (!isCloud()) await saveDatabaseEncryptionSettings();
    // Nothing changed: nothing to write.
    const response = Object.keys(payload).length === 0 ? { ok: true } : await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        // A refused value (e.g. a CLI path that isn't an executable file, #3364) says why.
        const data = await response.json().catch(() => null);
        const err = new Error(`settings save failed (${response.status})`);
        if (data && typeof data.error === 'string') err.userMessage = data.error;
        throw err;
    }
    state.settings = { ...state.settings, ...payload };
    if (_settingsAtOpen) _settingsAtOpen = { ..._settingsAtOpen, ...payload }; // the dialog stays open on a cancelled backend change
    if (!isCloud() && state.privacyStatus) {
        state.privacyStatus.remote_access_enabled = remoteAccessEnabled;
        state.privacyStatus.remote_access_restart_required = state.privacyStatus.remote_access_effective !== remoteAccessEnabled;
    }
    if (!isCloud() && state.privacyStatus) {
        const log = state.privacyStatus.debug_input_log || {};
        state.privacyStatus.debug_input_log = { ...log, enabled: log.forced === true || debugInputLog };
        // The server knows whether a log file is now kept on disk; refresh from it.
        try {
            const fresh = await fetch('/api/system/privacy');
            if (fresh.ok) {
                const body = await fresh.json();
                if (body && body.debug_input_log) state.privacyStatus.debug_input_log = body.debug_input_log;
            }
        } catch { /* keep the local guess */ }
    }
    if (!isCloud()) renderRemoteAccessStatus(state.privacyStatus);
    if (!isCloud()) renderDebugInputLogStatus(state.privacyStatus);
    return nothingToSave;
}

/** Puts the saved settings on the page: the theme, the open session's capture, the terminal, the scrollbars, the changed files. */
async function applySettingsEffects({ themeSaved, theme, customTheme, fitPaneWidth, terminalFontSize, terminalScrollback, showScrollbars, gitDiffMode }, oldGitDiffMode) {
    // Defaults may have changed — force next ACF open to re-fetch.
    _invalidateDefaultModels();

    // The theme only when the person changed it (#6114): a Save that left the control alone changes nothing on the page and writes no theme.
    if (themeSaved) {
        // Clear any previously applied custom CSS variables
        clearCustomThemeVars();

        if (customTheme) {
            // Load and apply the custom theme (sets base + variables)
            await applyCustomThemeByName(customTheme);
        } else {
            // Apply built-in theme
            applyTheme(theme);
        }
    }

    // If a live session is selected, force re-render with new default
    if (state.currentSession?.session_id) {
        const el = document.getElementById("pane-capture");
        if (el && el._lastCapture) {
            renderCaptureText(el, el._lastCapture);
        }
    }

    // Trigger pane width sync if the setting was just enabled
    if (fitPaneWidth) {
        syncPaneWidth();
    }

    // Apply font size and scrollback to existing terminal
    const term = getTerminal();
    if (term) {
        term.options.fontSize = terminalFontFor(terminalFontSize);
        term.options.scrollback = parseInt(terminalScrollback, 10) || 20000;
        const { fitTerminal } = await importOnce('./xterm_renderer.js');
        fitTerminal();
    }

    // Apply scrollbar visibility
    document.body.classList.toggle('no-scrollbars', !showScrollbars);

    // Refresh changed files if git diff mode changed
    if (gitDiffMode !== oldGitDiffMode) {
        refreshChangedFiles();
    }
}

export async function applySettings() {
    const form = readSettingsForm();
    browserLocal.set("coral-update-check-enabled", form.checkUpdates ? "true" : "false");
    const oldGitDiffMode = state.settings?.git_diff_mode || 'previous_commit';

    try {
        const nothingToSave = await saveSettings(form);
        await applySettingsEffects(form, oldGitDiffMode);
        const updatesSaved = updatesUiOn() ? await importOnce('./update_settings.js').then(m => m.applyUpdatePrefs()) : false; // the update switch and channel (#5275, #5558)
        const modelsSaved = isCloud() ? false : await importOnce('./custom_models.js').then(m => m.applyCustomModels()); // the custom models (#5480)
        if (modelsSaved) { _invalidateAgentModels(); (await importOnce('./model_labels.js')).clearModelsCache(); }
        // the rows by name (#7041), not "Settings saved" for every change; what was saved apart (custom models, the update choices) is named too
        const extra = [modelsSaved && 'Custom models', updatesSaved && 'Updates'].filter(Boolean);
        showToast(nothingToSave && !extra.length ? NOTHING_TO_SAVE : savedWords(changedSince(form.payload), { extra, restart: !!state.privacyStatus?.remote_access_restart_required }));
        _formAtOpen = formKey(); _payloadAtOpen = payloadNow(); refreshUnsavedNote();
    } catch (e) {
        showToast(e && e.userMessage ? `Failed to save settings: ${e.userMessage}` : "Failed to save settings", true);
        return;
    }

    // A changed terminal backend asks first and applies at the next start (#3634).
    try {
        const tb = await importOnce('./terminal_backend.js');
        if (!(await tb.applyTerminalBackendChange())) return; // cancelled: the dialog stays open
    } catch { /* the rest is saved */ }
    hideSettingsModal();
}
