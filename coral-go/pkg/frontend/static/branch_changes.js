/* Branches opens the same agent-scoped files and read-only inline diffs as Files.
 * The explicit context keeps reads and comments on this branch's agent, without changing the selected chat. */
import { serverFetch, isCloud, isLocalServer } from './server_base.js';
import { importOnce } from './import_once.js';
const { showFileDiff, hideFileDiff } = await importOnce('./inline_diff.js');
import { state } from './state.js';
import { el } from './dom_el.js';

export function openBranchChanges(worktree, agents, team, server) {
    const dialog = el('dialog', 'branches-changes-dialog dlg-flow');
    const heading = el('h2', '', `Changes on ${worktree.branch || worktree.head || 'this branch'}`);
    heading.id = 'branch-changes-heading'; dialog.setAttribute('aria-labelledby', heading.id);
    const close = el('button', 'btn btn-small branch-close', 'Close'); close.type = 'button';
    const header = el('div', 'branch-changes-header'); header.append(heading, close);
    const note = el('p', 'branches-note', 'Read-only changes. Select lines to comment, or place the cursor on a line and choose Comment on line.');
    const label = el('label', 'branch-agent-label', 'Send comments to '), select = document.createElement('select');
    for (const agent of agents) { const option = document.createElement('option'); option.value = agent.session_id; option.textContent = agent.display_name || agent.name; select.append(option); }
    label.append(select);
    const compareLabel = el('label', 'branch-agent-label', 'Comparison (shared with Files) '), compare = document.createElement('select');
    for (const [value, words] of [['uncommitted', 'Since my last commit'], ['last_commit', 'In my last commit'], ['branch_point', 'Since I branched'], ['previous_commit', 'Last commit + uncommitted'], ['main_head', 'Compared with the main branch']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = words; compare.append(option);
    }
    compare.className = 'branch-compare'; compareLabel.append(compare);
    const content = el('div', 'branch-changes-content');
    dialog.append(header, note, label, compareLabel, content); document.body.append(dialog);
    let generation = 0;
    const clear = () => { for (const slot of content.querySelectorAll('.file-diff')) hideFileDiff(slot); content.replaceChildren(); };
    const finish = () => { ++generation; clear(); dialog.remove(); };
    close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', finish, { once: true });
    const load = async () => {
        const mine = ++generation;
        clear(); content.append(el('p', 'branches-note', 'Reading changed files…'));
        const agent = agents.find(a => a.session_id === select.value);
        if (!agent) { content.replaceChildren(el('p', 'branches-note', 'No live agent is available to read this branch’s files.')); return; }
        const context = { session: { ...agent, type: 'live', board_project: team }, server };
        try {
            const qs = new URLSearchParams({ session_id: agent.session_id, worktree: 'follow' });
            const response = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(agent.name)}/files?${qs}`);
            if (!response.ok) throw new Error('read refused');
            const data = await response.json();
            if (mine !== generation || !dialog.isConnected) return;
            clear();
            compare.value = data.diff_mode || 'uncommitted';
            context.mode = compare.value;
            if (data.compare?.label) content.append(el('p', 'branches-note', data.compare.label));
            if (!data.files?.length) { content.append(el('p', 'branches-note', data.is_git === false ? 'This folder is not a git repository.' : 'No changed files in this comparison.')); return; }
            if (data.truncated || data.filtered_truncated) content.append(el('p', 'branches-note', 'Only part of the changed-file list is shown.'));
            for (const file of data.files) {
                const row = el('div', 'file-item'), button = el('button', 'btn btn-small branch-file-open', file.filepath);
                button.type = 'button'; button.setAttribute('aria-expanded', 'false');
                const slot = el('div', 'file-diff'); slot.dataset.filepath = file.filepath; slot.hidden = true;
                row.append(button); content.append(row, slot);
                button.addEventListener('click', () => {
                    const open = slot.hidden; button.setAttribute('aria-expanded', String(open));
                    if (open) showFileDiff(slot, file, false, context); else hideFileDiff(slot);
                });
            }
            if (isCloud()) note.textContent = 'Read-only changes. Comments on a diff are made on the computer itself.';
        } catch {
            if (mine === generation && dialog.isConnected) content.replaceChildren(el('p', 'branches-note', 'Could not read these changes. Close this view and try again.'));
        }
    };
    compare.addEventListener('change', async () => {
        compare.disabled = true;
        try {
            const response = await serverFetch(server, '/api/settings/git-diff-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: compare.value }) });
            if (!response.ok) throw new Error('comparison refused');
            if (isLocalServer(server) && !isCloud()) state.settings = { ...state.settings, git_diff_mode: compare.value };
            await load();
        } catch { if (dialog.isConnected) content.prepend(el('p', 'branches-note', 'Could not change the comparison. Close this view and try again.')); }
        finally { compare.disabled = false; }
    });
    select.addEventListener('change', load);
    dialog.showModal(); close.focus(); load();
}
