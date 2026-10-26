/* The New agent dialog's first step (Where it launches) is a settings_view in form mode (#8368): the folder, with Browse, the recent folders, the home-folder note and the folder list under it. The pieces other
 * modules fill stay in the page under their ids and are moved under the field (field.live); the field keeps its id (launch-dir), so the rest of the dialog reads it as before. The later steps (persona, provider and
 * the agent's sections) are their own modules. */
import { mountSettingsView } from './settings_view.js';
import { onBuilt } from './lazy_dom.js';

let _view = null;

/** The form of step 1, once the dialog is built. */
export function agentForm() { return _view; }

function mount(modal) {
    const host = modal.querySelector('#agent-form-host');
    if (!host || _view) return;
    const root = host.dataset.coralRoot || '';
    const fields = [
        { key: 'dir', type: 'path', id: 'launch-dir', label: 'Folder', required: true, requiredMessage: 'Choose a folder: type a path, or use Browse.', messageAsIs: true, placeholder: 'Choose a folder', attrs: { 'data-coral-root': root },
            live: [{ id: 'btn-browse', wide: true, describes: false }, { id: 'launch-dir-recents', wide: true, describes: false }, { id: 'launch-dir-hint', describes: false }, { id: 'launch-dir-note', describes: false }, { id: 'dir-browser', wide: true, describes: false }] },
    ];
    _view = mountSettingsView(host, { mode: 'form', fields });
}

onBuilt('launch-modal', mount);
