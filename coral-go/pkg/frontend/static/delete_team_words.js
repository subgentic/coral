/* The Remove team dialog's words, in a module of their own (#16895): the dialog is drawn from a click, so they are read then, not at start. Short lines, one under another. */
import { hideConfirmModal } from './confirm_dialog.js';
const oneLine = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** The Remove team dialog's words (#15277): what goes, what stays, and (with the names of agents still running on it) that they are stopped first by "Stop agents and remove". */
export function deleteTeamWords(team, running = [], project = '') {
    const name = oneLine(team);
    if (project) setTimeout(() => addArchiveInstead(project), 0); // the question is drawn right after these words are returned
    const shown = running.length > 5 ? `${running.slice(0, 5).join(', ')} and ${running.length - 5} more` : running.join(', ');
    const live = running.length ? ` ${running.length} agent${running.length === 1 ? ' is' : 's are'} running on it: ${shown}. Stop agents and remove stops them first.` : '';
    return [`Remove team "${name}"?`, live.trim(), "This removes the team's messages, tasks, goals, members, reminders, waits, presets, settings, artifact tags and health data for good.",
        "The files its agents uploaded are not deleted, but their tags, review questions and decisions go with the team.", "The agents' chats stay in History; the files in the team's folder and the logs are not touched.", 'This cannot be undone.', 'Want to keep it? Archive team keeps everything and takes the team out of the sidebar. Restore team on the Teams page brings it back.'].filter(Boolean).join('\n');
}

/** The Remove team dialog's "Archive team instead" button (#21850): the keep-everything choice beside the delete. It closes the question and asks the Archive team one. */
export function addArchiveInstead(project) {
    const actions = document.querySelector('#confirm-modal .modal-actions'), yes = document.getElementById('confirm-modal-yes');
    if (!actions || !yes) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.id = 'confirm-modal-alt'; b.textContent = 'Archive team instead';
    b.addEventListener('click', async () => { hideConfirmModal(); window.toggleTeamSleep?.(project, 'archive'); });
    yes.before(b);
    const modal = document.getElementById('confirm-modal'), mo = new MutationObserver(() => { if (modal.style.display === 'none') { b.remove(); mo.disconnect(); } }); // the button belongs to this one question: gone when the modal closes
    mo.observe(modal, { attributes: true, attributeFilter: ['style'] });
}
