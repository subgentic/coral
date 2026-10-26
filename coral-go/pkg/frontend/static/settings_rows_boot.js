/* The Settings dialog's rows that are fields (settings_fields.js) exist from the moment the dialog's markup is built, whichever code builds it (the dialog's own open, a test that builds every lazy part): this small module is
 * loaded at startup, starts loading the view that draws them at once, and draws when the modal is built (at once when that view is already here, a moment later when it is not). The dialog's open waits for it. */
import { onBuilt, ensureBuilt } from './lazy_dom.js';
import { importOnce } from './import_once.js';
import { drawSettingsGroups } from './settings_fields.js';
import { applySessionSummaryPref } from './session_rows.js';

let mount = null;
const loading = importOnce('./settings_view.js').then(m => { mount = m.mountSettingsView; }).catch(() => {});

function draw(modal) {
    if (!mount) return false;
    drawSettingsGroups(modal, mount);
    applySessionSummaryPref(); // the summary box is set from the saved preference as soon as it exists (session_rows.js ran its own hook before these rows were drawn)
    return true;
}
onBuilt('settings-modal', modal => { if (!draw(modal)) loading.then(() => draw(modal)); });

/** Resolves once the Settings dialog is built and its rows are drawn (the dialog's open waits for it). */
export async function settingsRowsReady() {
    const modal = ensureBuilt('settings-modal');
    await loading;
    if (modal) draw(modal);
    return modal;
}
