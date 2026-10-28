/* The Settings dialog's form: what its controls hold as a payload, the "Unsaved changes" note, and what changed since it opened (moved out of settings_dialog.js, #8383). */
import { defaultTerminalFont } from './terminal_font.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { filterSettingsPayload } from './cloud_settings.js';
import { isCloud } from './server_base.js';
import { settingBool, changedSettings, defaultThemeChoice } from './settings_core.js';
const { databaseEncryptionChanged } = await importOnce('./settings_machine.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { retentionSettings, receivedMaxSetting, artifactStoreMaxSetting } = await importOnce('./settings_storage.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { dropUnfilledCLIPaths, editedCLIPathKeys } = await importOnce('./settings_fill.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { settingsAtOpen, formAtOpen, payloadAtOpen } = await importOnce('./settings_snapshots.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

/** The "Unsaved changes" note in Settings' footer (UI audit #5589, finding 27): shown while the form differs from what it held when it finished opening (or was last saved), or a database encryption or terminal backend or wake choice is pending. The baseline is the form's own payload, not the saved settings: a new install has no saved settings, so everything would differ. Changes to the custom models and the update switches are saved too but are not counted here. */
export const formKey = () => { try { return JSON.stringify(readSettingsForm().payload); } catch { return null; } };
export const payloadNow = () => { try { return readSettingsForm().payload; } catch { return null; } };
/** The part of a saved payload the person changed since the dialog opened (or was last saved). */
export const changedSince = payload => Object.fromEntries(Object.entries(payload).filter(([k, v]) => !payloadAtOpen() || JSON.stringify(payloadAtOpen()[k]) !== JSON.stringify(v)));
/** Whether a field or the database encryption choice holds a change not saved yet: read at once, so Close can decide in the same turn (#10526). */
export const unsavedFields = () => formAtOpen() !== null && (formKey() !== formAtOpen() || databaseEncryptionChanged());
/** unsavedFields, or the terminal backend choice (saved apart): what the note and the Cancel word show. */
async function hasUnsavedChanges() {
    if (unsavedFields()) return true;
    if (formAtOpen() === null) return false;
    try { return await importOnce('./terminal_backend.js').then(tb => tb.hasUnsavedBackendChange(), () => false); } catch { return false; }
}
export async function refreshUnsavedNote() {
    const note = document.getElementById('settings-unsaved');
    if (!note) return;
    const dirty = await hasUnsavedChanges();
    if (note.hidden === dirty) note.hidden = !dirty;
    const away = document.getElementById('settings-cancel-btn'), word = dirty ? 'Cancel' : 'Close'; // nothing to cancel until something is changed: on a page with nothing to edit it is plain Close (Beta Tester, #9955)
    if (away && away.textContent !== word) away.textContent = word;
    // A note, not a live region (#6656): while there are unsaved changes the Save button is described by it, so it is read when the person reaches Save, where it matters, and not announced on every edit.
    const save = document.getElementById('settings-save-btn');
    if (save) { if (dirty) { if (save.getAttribute('aria-describedby') !== 'settings-unsaved') save.setAttribute('aria-describedby', 'settings-unsaved'); } else if (save.hasAttribute('aria-describedby')) save.removeAttribute('aria-describedby'); }
}
/** What the dialog's controls hold: the payload to save (only what the person changed, and on the hub only the per-user keys) and the values the page applies once it is saved. */
export function readSettingsForm() {
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
    payload = changedSettings(dropUnfilledCLIPaths(payload), settingsAtOpen(), themeValue, [...editedCLIPathKeys(), ...(document.getElementById('settings-permission-mode')?.dataset.edited === '1' && document.getElementById('settings-permission-mode').value ? ['default_permission_mode'] : [])], defaultThemeChoice());
    // The hub accepts only the per-user keys (anything else refuses the whole request); the machine ones are hidden.
    if (isCloud()) payload = filterSettingsPayload(payload).kept;

    return { themeValue, themeSaved: 'theme' in payload, theme, customTheme, payload, checkUpdates, fitPaneWidth, terminalFontSize, terminalScrollback, showScrollbars, gitDiffMode, remoteAccessEnabled, debugInputLog };
}
