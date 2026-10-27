/* The Settings dialog as a module of its own (#9111), as the Resume and Default Prompts dialogs are (#3836): opening Settings does not load the launch, team and wizard
 * dialogs that modals.js carries. The dialog's template is built when this module loads, which is its first use (#4500); modals.js builds the same template and shares
 * the same settings_dialog.js, so loading both is the same dialog. */
import { importOnce } from './import_once.js';
import { ensureBuilt } from './lazy_dom.js';

ensureBuilt('settings-modal');
const settingsDialog = await importOnce('./settings_dialog.js');
export const { showSettingsModal, hideSettingsModal, applySettings } = settingsDialog;
