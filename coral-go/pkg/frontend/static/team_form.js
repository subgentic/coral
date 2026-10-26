/* The New team dialog's first step (Name and where it launches) is a settings_view in form mode (#8335): the team's name, its folder (with the folder browser and the recent folders under it),
 * the address of another computer, and a git worktree with its base branch. The pieces other modules fill (the name's notice, Browse, the recent folders, the folder list) stay in the page
 * under their ids and are moved under their field (field.live); the fields keep their ids, so the rest of the dialog reads them as before. Step 2 and 3 are their own pages. */
import { mountSettingsView } from './settings_view.js';
import { boardNameProblem } from './utils.js';
import { onBuilt } from './lazy_dom.js';

let _view = null;

/** The form of step 1, once the dialog is built. */
export function teamForm() { return _view; }

function rowOf(id) { return document.getElementById(id)?.closest('.sv-row') || null; }

/** Show the other computer's address (the Machine is "Another computer's address..."). */
export function showTeamAddress(on) {
    const row = rowOf('team-board-server');
    if (row) row.hidden = !on;
}

/** Offer the worktree (the folder is a git repo on the target server); no repo, no worktree. */
export function showTeamWorktree(on) {
    const row = rowOf('launch-team-worktree');
    if (!row) return;
    row.hidden = !on;
    if (!on) _view?.set('worktree', false); // the base branch row follows the switch
    _view?.refresh();
}

function mount(modal) {
    const host = modal.querySelector('#team-form-host');
    if (!host || _view) return;
    const root = host.dataset.coralRoot || '';
    const fields = [
        { key: 'name', type: 'text', id: 'team-board-name', label: 'Team name', required: true, requiredMessage: 'Team name is required', messageAsIs: true, placeholder: 'e.g. auth-feature, sprint-42',
            help: "Letters, digits, - and _. It names the team's board.", attrs: { maxlength: '64' }, live: ['team-board-name-hint'],
            validate: v => boardNameProblem(String(v || '').trim()), setup: e => e.setAttribute('data-on-input', 'm-validate-team-name') },
        { key: 'dir', type: 'path', id: 'launch-team-dir', label: 'Folder', required: true, requiredMessage: 'Choose a folder for the team', messageAsIs: true, placeholder: 'Choose a folder', attrs: { 'data-coral-root': root },
            live: [{ id: 'btn-browse-team', wide: true, describes: false }, { id: 'launch-team-dir-recents', wide: true, describes: false }, { id: 'dir-browser-team', wide: true, describes: false }] },
        { key: 'server', type: 'text', id: 'team-board-server', label: "Another computer's address", placeholder: 'e.g. http://remote-machine:8420' },
        { key: 'worktree', type: 'toggle', id: 'launch-team-worktree', label: 'Launch in a git worktree', default: false, help: 'The team works on its own branch in an isolated copy of the repository.' },
        { key: 'base', type: 'text', id: 'launch-team-base-branch', label: 'Base branch', placeholder: "the repo's current branch", visibleWhen: v => !!v.worktree },
    ];
    _view = mountSettingsView(host, { mode: 'form', fields });
    const server = document.getElementById('team-board-server'); if (server) server.disabled = true; // the machine's own entry reveals it (launch_dialog.js _syncTeamAddress)
    showTeamAddress(false);
    showTeamWorktree(false);
}

onBuilt('launch-modal', mount);
