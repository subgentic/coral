import { buildSettingsHints } from './settings_nav.js';
import { loadStyles } from './lazy_styles.js';
/* Build the Settings field rows only when their dialog is built. The open path awaits readiness. */
import { onBuilt, ensureBuilt, buildAllLazy } from './lazy_dom.js';
import { mountSettingsView } from './settings_view.js';
import { importOnce } from './import_once.js';
let pending = null;
function draw(modal) {
    if (!modal) return Promise.resolve(null);
    if (!pending) pending = Promise.all([importOnce('./settings_fields.js'), loadStyles('settings.css')]).then(([m]) => { m.drawSettingsGroups(modal, mountSettingsView); buildSettingsHints(modal); return modal; }).catch(e => { pending = null; throw e; });
    return pending;
}
onBuilt('settings-modal', modal => { draw(modal).catch(e => console.error('Settings fields could not be loaded', e)); });
export function settingsRowsReady() { return draw(ensureBuilt('settings-modal')); }

if (typeof window !== 'undefined') (window.__coral ||= {}).buildAllLazy = async () => { buildAllLazy(); await settingsRowsReady(); };
