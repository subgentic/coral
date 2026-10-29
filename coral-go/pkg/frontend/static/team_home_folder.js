/* A team's home folder (#10815): Team settings shows the folder the team's agents start in (launch, wake, restart, resurrect) and lets the Operator on this computer change it.
   PUT /api/teams/detail/<name>/home-folder {working_dir}: Coral answers 400 {error, field} for a folder that is not absolute, does not exist, is not a folder, or (a worktree team) is outside
   Coral's worktrees folder, and 403 for anything but the Operator. A running agent stays where it is: the new folder applies the next time each one starts, and the words say so.
   Not a field of the settings form: it has its own button, like Rename board, so the bar's Save does not hold it. */

import { serverUrl, splitKey } from './server_base.js';

let _seq = 0;

/** The home folder row for team (a board key). The folder is read from the team's own record; through Coral Hub (not the local server) it is shown without a way to change it. */
export function teamHomeFolderControl(team, { canChange = true } = {}) {
    const n = ++_seq;
    const { server, name } = splitKey(team);
    const url = suffix => serverUrl(`/api/teams/detail/${encodeURIComponent(name)}${suffix}`, server);
    const wrap = document.createElement('div');
    wrap.className = 'board-rename team-home-folder';
    const current = document.createElement('p');
    current.className = 'team-home-folder-current';
    current.id = `team-home-folder-current-${n}`;
    current.textContent = 'Loading…';
    const note = document.createElement('p');
    note.className = 'board-rename-note team-home-folder-note';
    note.textContent = 'Running agents stay where they are. The new folder applies the next time each one starts: a wake, a restart or a resurrect.';
    wrap.append(current);
    if (canChange) {
        const form = document.createElement('div');
        form.className = 'board-rename-form team-home-folder-form';
        form.setAttribute('role', 'group');
        form.setAttribute('aria-label', 'Change the home folder');
        const label = document.createElement('label');
        label.htmlFor = `team-home-folder-input-${n}`;
        label.textContent = 'Folder';
        const input = document.createElement('input');
        input.id = `team-home-folder-input-${n}`;
        input.name = 'home_folder';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-describedby', `team-home-folder-error-${n}`);
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-sm btn-primary team-home-folder-change';
        save.textContent = 'Change folder';
        const error = document.createElement('p');
        error.className = 'board-rename-error';
        error.id = `team-home-folder-error-${n}`;
        error.setAttribute('role', 'alert');
        form.append(label, input, save, error);
        wrap.append(form);
        const showError = msg => { error.textContent = msg || ''; if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); };
        input.addEventListener('input', () => showError(''));
        const change = async () => {
            if (save.disabled) return;
            const value = input.value.trim();
            if (!value) { showError('Enter the folder, as a full path.'); input.focus(); return; }
            save.disabled = true;
            try {
                const resp = await fetch(url('/home-folder'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ working_dir: value }) });
                const data = await resp.json().catch(() => null);
                if (!resp.ok) {
                    showError((data && (data.error || data.message)) || (resp.status === 403 ? "You can't change this folder from here." : `Couldn't change the folder (HTTP ${resp.status}).`));
                    input.focus();
                    return;
                }
                current.textContent = data.working_dir;
                input.value = '';
                showError('');
            } catch {
                showError("Couldn't reach Coral to change the folder.");
            } finally {
                save.disabled = false;
            }
        };
        save.addEventListener('click', change);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); change(); } });
    }
    wrap.append(note);
    fetch(url('')).then(async r => { const t = r.ok ? await r.json() : null; current.textContent = t && t.working_dir ? t.working_dir : 'Not set'; }).catch(() => { current.textContent = 'Not shown: the folder could not be read.'; });
    return wrap;
}
