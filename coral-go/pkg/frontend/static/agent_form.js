/* The New agent dialog's first step (Where it launches) is a settings_view in form mode (#8368): the folder, with Browse, the recent folders, the home-folder note and the folder list under it. The pieces other
 * modules fill stay in the page under their ids and are moved under the field (field.live); the field keeps its id (launch-dir), so the rest of the dialog reads it as before. The later steps (persona, provider and
 * the agent's sections) are their own modules. */
import { mountSettingsView } from './settings_view.js';
import { onBuilt } from './lazy_dom.js';

let _view = null;
let _nameView = null;

/** The form of step 1, once the dialog is built. */
export function agentForm() { return _view; }

/** Word the name field for what the dialog is doing: a new agent's optional name, or a team member's role (Add member and Edit member save a role, so it is Required). */
export function setAgentNameMode(member) {
    _nameView?.clearErrors();
    _nameView?.retext('name', member
        ? { label: 'Role', help: 'The role this member has on the team.', required: true, requiredMessage: 'A member needs a role' }
        : { label: 'Name', help: 'Choose a persona above and its name goes here, or type your own.', required: false });
}

function mount(modal) {
    const nameHost = modal.querySelector('#agent-name-host');
    if (nameHost && !_nameView) {
        _nameView = mountSettingsView(nameHost, { mode: 'form', fields: [
            { key: 'name', type: 'text', id: 'launch-agent-name-input', label: 'Name', placeholder: 'e.g. QA Engineer, Frontend Dev', messageAsIs: true, help: 'Choose a persona above and its name goes here, or type your own.', helpTextClass: 'launch-name-help' },
        ] });
    }
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
