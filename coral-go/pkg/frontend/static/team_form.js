/* The New team dialog's first step (Name and where it launches) is a settings_view in form mode (#8335), and so is its second, Members (#8476): the team's name, its folder (with the folder browser and the recent folders under it),
 * the address of another computer, and a git worktree with its base branch. The pieces other modules fill (the name's notice, Browse, the recent folders, the folder list) stay in the page
 * under their ids and are moved under their field (field.live); the fields keep their ids, so the rest of the dialog reads them as before. Step 3 is its own page (team_launch_settings.js). */
import { mountSettingsView } from './settings_view.js';
import { joinBrowse, FOLDER_ON_THIS_COMPUTER } from './dir_row.js';
import { boardNameProblem } from './utils.js';
import { onBuilt } from './lazy_dom.js';
import { usesSuggestion } from './folder_suggestion.js';
import { isHub } from './server_base.js';

let _view = null;

let _trustFor = ''; // the folder the person ticked "Trust this folder" for: a tick names its path, and is of no use for another


/** A tick for one folder does not carry to another: when the folder is no longer the ticked one the switch goes back to off. */
export function dropStaleTrustTick() {
    const t = document.getElementById('launch-team-trust'), d = document.getElementById('launch-team-dir');
    if (t && t.checked && (!d || d.value.trim() !== _trustFor)) { _view?.set('trust', false); _trustFor = ''; }
}

/** True when the person ticked "Trust this folder" for the folder that is in the field now, and the switch shows: the one case the launch asks for trust (#11889). */
export function trustTicked() {
    const t = document.getElementById('launch-team-trust'), d = document.getElementById('launch-team-dir');
    const row = t?.closest('.sv-row');
    return !!(t && t.checked && d && row && !row.hidden && d.value.trim() === _trustFor);
}

/** True when the suggested folder is known to be there already: Coral makes none then, so it trusts nothing without the person's tick (#11889). */
export function suggestionExists(input) { return !!input && input.dataset.exists === input.value.trim(); }

/** Ask the machine whether the suggested folder exists and redraw the trust rows: the line "Coral will ... trust it for them" is for a folder Coral makes, not one that was already there. */
export async function syncSuggestionExists() {
    const d = document.getElementById('launch-team-dir');
    if (!d) return;
    const dir = d.value.trim();
    if (!usesSuggestion(d)) { delete d.dataset.exists; _view?.refresh(); return; }
    let exists = false;
    try { exists = (await fetch('/api/filesystem/list?path=' + encodeURIComponent(dir))).ok; } catch { /* unknown: the line stays, the server decides */ }
    if (d.value.trim() !== dir) return; // the field changed while it was asked
    if (exists) d.dataset.exists = dir; else delete d.dataset.exists;
    _view?.refresh();
}

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

let _members = null;

/** Show "Set all workers to" (there is a worker to set): the row follows team_dialogs' member list. */
export function showTeamWorkers(on) {
    const row = rowOf('team-set-all');
    if (row) row.hidden = !on;
}

/** Step 2: the template, the bulk provider and the member list, as rows of a form. The pieces other modules fill (the template choices, the member rows, their menus) stay in the page under their ids and are moved into their row. */
function mountMembers(modal) {
    const host = modal.querySelector('#team-members-host'), parts = modal.querySelector('#team-members-parts');
    if (!host || !parts || _members) return;
    const take = sel => parts.querySelector(sel);
    const fields = [
        { key: 'template', type: 'custom', label: 'Start from a template', help: 'Optional. Fills the member list.', wide: true, render: slot => slot.append(take('.team-template-row')) },
        { key: 'workers', type: 'custom', label: 'Set all workers to', help: "Changes every worker's provider. The Orchestrator keeps its own, and each worker's model goes back to the default.", render: slot => slot.append(take('#team-allworkers')) },
        { key: 'members', type: 'custom', label: 'Members', wide: true, render: slot => { slot.append(take('#team-agents-count'), take('.team-agents-container')); } },
    ];
    _members = mountSettingsView(host, { mode: 'form', fields });
    showTeamWorkers(false);
}

function mount(modal) {
    const host = modal.querySelector('#team-form-host');
    if (!host || _view) return;
    const root = host.dataset.coralRoot || '';
    const fields = [
        { key: 'name', type: 'text', id: 'team-board-name', label: 'Team name', required: true, requiredMessage: 'Team name is required', messageAsIs: true, placeholder: 'e.g. auth-feature, sprint-42',
            help: "A team is a group of agents working on one board. Letters, digits, - and _.", attrs: { maxlength: '64' }, live: ['team-board-name-hint'],
            validate: v => boardNameProblem(String(v || '').trim()), setup: e => e.setAttribute('data-on-input', 'm-validate-team-name') },
        { key: 'dir', type: 'path', id: 'launch-team-dir', label: 'Folder for this team', help: FOLDER_ON_THIS_COMPUTER, required: true, requiredMessage: 'Choose a folder for the team', messageAsIs: true, placeholder: 'Choose a folder', attrs: { 'data-coral-root': root },
            live: [{ id: 'btn-browse-team', wide: true, describes: false }, { id: 'launch-team-dir-recents', wide: true, describes: false }, { id: 'launch-team-dir-suggest', describes: false }, { id: 'dir-browser-team', wide: true, describes: false }] },
        // Trusting the folder (#11889): a folder Coral makes is trusted for the agents that ask, and says so; an existing folder is trusted only when the person ticks it, naming the path. Neither shows through Coral Hub
        // (the server ignores the tick there). The server decides what it may trust: this is what is said and what is sent.
        { key: 'trustLine', type: 'custom', wide: true, label: ' ', render: slot => { const p = document.createElement('p'); p.id = 'launch-team-trust-line'; p.className = 'sv-help'; p.textContent = 'Coral will start these agents in this folder and trust it for them.'; slot.append(p); },
            visibleWhen: () => { const d = document.getElementById('launch-team-dir'); return !isHub() && usesSuggestion(d) && !suggestionExists(d); } },
        { key: 'trust', type: 'toggle', id: 'launch-team-trust', label: 'Trust this folder: its settings and tools can run', default: false, help: 'Off by default.',
            helpOf: () => { const f = document.getElementById('launch-team-dir')?.value.trim() || 'this folder'; // off: say plainly what that means, so a typed folder is not taken for one Coral trusts (#12413)
                return document.getElementById('launch-team-trust')?.checked ? 'On, ' + f + " is trusted for the team's agents, so settings, tools and hooks in it run with no question. Tick it only for code you trust."
                    : 'Off by default. Coral will not trust ' + f + " unless this is on, so each agent's CLI asks about the folder when it starts."; },
            visibleWhen: () => { const d = document.getElementById('launch-team-dir'); return !isHub() && !!(d && d.value.trim() && (!usesSuggestion(d) || suggestionExists(d))); } },
        { key: 'server', type: 'text', id: 'team-board-server', label: "Another computer's address", placeholder: 'e.g. http://remote-computer:8420' },
        { key: 'worktree', type: 'toggle', id: 'launch-team-worktree', label: 'Launch in a git worktree', default: false, help: 'The team works on its own branch in an isolated copy of the repository.' },
        { key: 'base', type: 'text', id: 'launch-team-base-branch', label: 'Base branch', placeholder: "the repo's current branch", visibleWhen: v => !!v.worktree },
    ];
    _view = mountSettingsView(host, { mode: 'form', fields });
    // The folder the person ticked "Trust this folder" for: registered here, when the form is built, not at load (a page-wide listener at start shows in the startup golden, #11889).
    modal.addEventListener('change', e => { if (!e.target || e.target.id !== 'launch-team-trust') return; _trustFor = e.target.checked ? (document.getElementById('launch-team-dir')?.value.trim() || '') : ''; _view?.refresh(); }); // the sentence under the switch follows it
    joinBrowse('launch-team-dir', 'btn-browse-team'); // Browse at the input's right, as Open folder has it (#9489)
    const server = document.getElementById('team-board-server'); if (server) server.disabled = true; // the machine's own entry reveals it (launch_dialog.js _syncTeamAddress)
    showTeamAddress(false);
    showTeamWorktree(false);
}

onBuilt('launch-modal', mount);
onBuilt('launch-modal', mountMembers);
