/* The Settings dialog's rows that are fields (settings_fields.js) exist from the moment the dialog's markup is built, whichever code builds it (the dialog's own open, a test that builds every lazy part): this module is
 * loaded at startup together with the view that draws them (settings_view.js and the shared section list it uses), so the rows are drawn at once when the modal is built, on a slow machine as on a fast one. */
import { onBuilt, ensureBuilt } from './lazy_dom.js';
import { mountSettingsView } from './settings_view.js';
import { drawSettingsGroups } from './settings_fields.js';
import { applySessionSummaryPref } from './session_rows.js';

function draw(modal) {
    drawSettingsGroups(modal, mountSettingsView);
    applySessionSummaryPref(); // the summary box is set from the saved preference as soon as it exists (session_rows.js ran its own hook before these rows were drawn)
}
onBuilt('settings-modal', draw);

/** The Settings dialog, built and with its rows drawn (the dialog's open takes it from here). */
export function settingsRowsReady() {
    const modal = ensureBuilt('settings-modal');
    if (modal) draw(modal);
    return Promise.resolve(modal);
}
