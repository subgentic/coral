/* Main Settings values: a complete payload for row comparisons, and a diff for the legacy combined-save probes. */
import { defaultTerminalFont } from './terminal_font.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { filterSettingsPayload } from './cloud_settings.js';
import { isCloud } from './server_base.js';
import { settingBool, changedSettings, defaultThemeChoice } from './settings_core.js';
const { retentionSettings, receivedMaxSetting, artifactStoreMaxSetting } = await importOnce('./settings_storage.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { dropUnfilledCLIPaths, editedCLIPathKeys } = await importOnce('./settings_fill.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { readInboxSettings } = await importOnce('./settings_inbox.js'); // what reaches Needs you (#12144): lazy the same way
const { settingsAtOpen, payloadAtOpen } = await importOnce('./settings_snapshots.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

export const payloadNow = () => { try { return readSettingsForm().payload; } catch { return null; } };
/** Keys changed since the last combined-save probe, for the legacy test surface. */
export const changedSince = payload => Object.fromEntries(Object.entries(payload).filter(([k, v]) => !payloadAtOpen() || JSON.stringify(payloadAtOpen()[k]) !== JSON.stringify(v)));
/** What the dialog's controls hold: the payload to save (only what the person changed, and on the hub only the per-user keys) and the values the page applies once it is saved. */
export function readSettingsForm(all = false) {
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
    const pick = id => document.getElementById(id)?.value; // undefined: the row is not on this page (the Hub's), so the key is not sent
    const typedDefaults = {};
    for (const t of ['codex', 'agy', 'pi']) { const v = pick(`settings-default-thinking-${t}`); if (v !== undefined) typedDefaults[`default_thinking_${t}`] = v; }
    for (const t of ['claude', 'codex', 'agy', 'pi']) {
        const m = pick(`settings-orchestrator-model-${t}`), th = pick(`settings-orchestrator-thinking-${t}`);
        if (m !== undefined) typedDefaults[`default_orchestrator_model_${t}`] = m.trim();
        if (th !== undefined) typedDefaults[`default_orchestrator_thinking_${t}`] = th;
    }
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
    const launchInWorktree = document.getElementById("settings-launch-in-worktree")?.checked ?? settingBool(state.settings?.launch_in_worktree || undefined, false);
    const nudgeClaudeArtifacts = document.getElementById("settings-nudge-claude-artifacts")?.checked ?? settingBool(state.settings?.nudge_claude_artifacts || undefined, true);
    const boardHealthMonitor = document.getElementById("settings-board-health-monitor")?.checked ?? settingBool(state.settings?.board_health_monitor || undefined, true);
    const autoResume = document.getElementById("settings-auto-resume")?.checked ?? settingBool(state.settings?.auto_resume_after_api_error || undefined, false);
    const autoSleep = document.getElementById("settings-auto-sleep")?.checked ?? settingBool(state.settings?.auto_sleep || undefined, true);
    // Whole minutes inside the server's range (#12111): what is typed outside it is sent as the nearest end, never as text.
    const autoSleepRaw = Number.parseInt(document.getElementById("settings-auto-sleep-minutes")?.value ?? state.settings?.auto_sleep_idle_minutes ?? "60", 10);
    const autoSleepMinutes = String(Number.isFinite(autoSleepRaw) ? Math.min(1440, Math.max(15, autoSleepRaw)) : 60);
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
        ...typedDefaults,
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
        launch_in_worktree: launchInWorktree,
        ...readInboxSettings(state.settings),
        nudge_claude_artifacts: nudgeClaudeArtifacts,
        board_health_monitor: boardHealthMonitor,
        auto_resume_after_api_error: autoResume,
        auto_sleep: autoSleep,
        auto_sleep_idle_minutes: autoSleepMinutes,
        auto_goals: autoGoals,
        ...artifactStoreMaxSetting(),
        ...receivedMaxSetting(),
        ...retentionSettings(),
        debug_input_log: debugInputLog,
        remote_access_enabled: remoteAccessEnabled,
    };

    // Only what the person changed since the dialog opened: a field this dialog never touched (a CLI path another
    // tab saved meanwhile) is not written back with the value this page opened with.
    if (!all) payload = changedSettings(dropUnfilledCLIPaths(payload), settingsAtOpen(), themeValue, [...editedCLIPathKeys(), ...(document.getElementById('settings-permission-mode')?.dataset.edited === '1' && document.getElementById('settings-permission-mode').value ? ['default_permission_mode'] : [])], defaultThemeChoice());
    // The hub accepts only the per-user keys (anything else refuses the whole request); the machine ones are hidden.
    if (isCloud()) payload = filterSettingsPayload(payload).kept;

    return { themeValue, themeSaved: 'theme' in payload, theme, customTheme, payload, checkUpdates, fitPaneWidth, terminalFontSize, terminalScrollback, showScrollbars, gitDiffMode, remoteAccessEnabled, debugInputLog };
}
