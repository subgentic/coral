/* Moved out of modals.js as it was (#4684): The Settings dialog: its sections, the API key, storage, database encryption, filling and saving it. No behaviour change. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { applyCloudSettingsDialog } from './cloud_settings.js';
import { isCloud } from './server_base.js';
import { attachDialogFocus } from './dialog_focus.js';
import { openSettingsGroup } from './settings_nav.js';
import { settingsRowsReady } from './settings_rows_boot.js';
const { loadTelemetryInstallID } = await importOnce('./settings_machine.js'); // lazy like this file: a lazy module is loaded through importOnce (import_hygiene)
const { CLI_PATH_FIELDS, _fillMachineSettings, _fillThemeSelect, _fillDefaults, _fillApiKey, _fillCliAndModels, _fillTerminalAndBrowserPrefs, _fillFilesAndGit } = await importOnce('./settings_fill.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { formKey, payloadNow, refreshUnsavedNote } = await importOnce('./settings_form.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { hideSettingsModal, applySettings } = await importOnce('./settings_save.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)
const { setSettingsAtOpen, setFormAtOpen, setPayloadAtOpen } = await importOnce('./settings_snapshots.js'); // lazy like settings_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

export { hideSettingsModal, applySettings }; // the dialog's public surface stays here; closing and Save live in settings_save.js (#8383)

export async function showSettingsModal(group) {
    await settingsRowsReady(); // the dialog's rows that are fields (settings_fields.js) are in the page before anything reads them by id
    // Focus moves in on open, Tab stays inside, and focus comes back on close (accessibility pass).
    attachDialogFocus(document.getElementById('settings-modal'));
    importOnce('./quiet_focus.js').then(m => m.quietFocus(document.getElementById('settings-modal')), () => {}); // the open tab takes the focus by script: no ring for a pointer's start, the ring for a key press (#7405, as #7391's New Agent)

    importOnce('./terminal_backend.js').then(m => m.loadTerminalBackendRow()).catch(() => {}); // #3634
    importOnce('./worktrees_panel.js').then(m => m.loadWorktrees()).catch(() => {}); // the kept worktrees, in Storage and cleanup (#6743)
    importOnce('./security_settings.js').then(m => m.loadSecurityRow()).catch(() => {}); // #3948
    importOnce('./firewall_warning.js').then(m => { m.renderFirewallRow(); m.renderSecurityNoticeRow(); }).catch(() => {}); // #295: where the firewall warning and the data-folder notice stay once their toasts are dismissed
    const s = state.settings || {};
    // What this dialog opens with: Save sends only the fields that end up different from it.
    setSettingsAtOpen({ ...s });
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
    setFormAtOpen(formKey()); // the form as it finished opening
    setPayloadAtOpen(payloadNow());
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
