/* The Settings dialog as a module of its own (#9111), as the Resume and Default Prompts dialogs are (#3836): opening Settings does not load the launch, team and wizard
 * dialogs that modals.js carries. The dialog's template is built when this module loads, which is its first use (#4500); modals.js builds the same template and shares
 * the same settings_dialog.js, so loading both is the same dialog. */
import { importOnce } from './import_once.js';
import { ensureBuilt } from './lazy_dom.js';

await importOnce('./settings_fields.js'); // schemas are part of this open path and register before the template builds
ensureBuilt('settings-modal');
const settingsDialog = await importOnce('./settings_dialog.js');
export const { showSettingsModal, hideSettingsModal, applySettings } = settingsDialog;

// The robot on each section's heading (#15152): the section's name, and where in the docs to read (Notifications and Network and Hub have a topic of their own).
const { agentCopyBeside, agentCopyLabelled } = await importOnce('./agent_copy_button.js');
const PANE_DOCS = { notifications: 'notifications', network: 'hub' };
// General has no More menu: its copy is a labelled Quiet button on the section's last row, not a lone robot (#15993).
for (const pane of document.querySelectorAll('#settings-modal .settings-pane[data-group]')) if (pane.dataset.group === 'general') { const row = document.createElement('div'); row.className = 'settings-copy-last'; row.append(agentCopyLabelled('settings', `Coral Settings, \u201c${pane.dataset.title}\u201d section.`)); pane.append(row); } else agentCopyBeside(pane.querySelector(':scope > .settings-pane-title'), PANE_DOCS[pane.dataset.group] || 'settings', `Coral Settings, \u201c${pane.dataset.title}\u201d section.`);
