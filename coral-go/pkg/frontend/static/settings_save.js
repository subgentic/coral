/* The Settings dialog's Save flow and closing: send the payload, put the saved settings on the page, close (moved out of settings_dialog.js, #8383). */
import { terminalFontFor } from './terminal_font.js';
import { importOnce } from './import_once.js';
import { updatesUiOn } from './update_flag.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { refreshChangedFiles } from './changed_files.js';
import { renderCaptureText, syncPaneWidth } from './capture.js';
import { getTerminal } from './xterm_renderer.js';
import { isCloud } from './server_base.js';
import { NOTHING_TO_SAVE } from './settings_diff.js';
import { savedWords, renderRemoteAccessStatus, renderDebugInputLogStatus, applyTheme, clearCustomThemeVars, applyCustomThemeByName, restoreSavedTheme } from './settings_core.js';
import { browserLocal } from './safe_storage.js';
const { _invalidateAgentModels, _invalidateDefaultModels } = await importOnce('./launch_models.js');
const { databaseEncryptionChanged, saveDatabaseEncryptionSettings } = await importOnce('./settings_machine.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { readSettingsForm, formKey, payloadNow, changedSince, refreshUnsavedNote } = await importOnce('./settings_form.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { settingsAtOpen, setSettingsAtOpen, setFormAtOpen, setPayloadAtOpen } = await importOnce('./settings_snapshots.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

export function hideSettingsModal() {
    document.getElementById("settings-modal").style.display = "none";
    restoreSavedTheme().catch(() => {}); // a theme previewed in the dialog and not saved goes back to the saved one (#10481)
    if (!isCloud()) importOnce('./custom_models.js').then(m => m.discardCustomModels()).catch(() => {}); // unsaved custom models are dropped with the dialog (#5480)
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
    if (settingsAtOpen()) setSettingsAtOpen({ ...settingsAtOpen(), ...payload }); // the dialog stays open on a cancelled backend change
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
        setFormAtOpen(formKey()); setPayloadAtOpen(payloadNow()); refreshUnsavedNote();
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
