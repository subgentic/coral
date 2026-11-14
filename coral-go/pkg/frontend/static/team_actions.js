/* What the sidebar's menus do to a team or a folder's agents: kill all, share, save as a template, sleep (moved out of render.js, #4996; no behaviour change). */
import { state } from './state.js';
import { registerDialog } from './modal_chrome.js';
import { sessionFolderKey, keyLabel, splitKey, inTeam, teamFetch } from './server_base.js';
import { browserLocal } from './safe_storage.js';
import { redrawLiveList } from './list_hooks.js';
import { showConfirmModal } from './confirm_dialog.js';
import { launchBlockedReason } from './hub_access.js';
import { showToast, escapeHtml } from './utils.js';
import { updateSettingList, upsertByName, parseList } from './settings_lists.js';
import { _passesFilters } from './list_filter_match.js';
import { killCount } from './agent_actions.js';
import { whatStaysKill } from './agent_words.js';
import { showPromptModal } from './prompt_modals.js';
import { worktreeConfirmWords } from './worktree_words.js';
import { showWorktreeNotice } from './worktree_notice.js';
import { killLiveSession, killLiveTeam, dropKilledRows } from './kill_live.js';
import { importOnce } from './import_once.js';

// The agents a folder or workflow group shows, and only those (#3053): team
// members are listed (and killed) under their team, archived agents in the
// Archived section, and with Group by Team on, workflow-run agents in their
// workflow group. A search narrows the group as it does in the list.
function _groupMembers(groupName) {
    const byTeam = browserLocal.get('coral-group-by-team') !== 'false';
    const shown = state.liveSessions.filter(s => !s.archived && !s.board_project && _passesFilters(s));
    if (groupName.startsWith('wf:')) {
        const wf = groupName.slice(3);
        return byTeam ? shown.filter(s => s.workflow_name === wf) : [];
    }
    return shown.filter(s => sessionFolderKey(s) === groupName && !(byTeam && s.workflow_name));
}

export async function killGroup(groupName) {
    const groupSessions = _groupMembers(groupName);
    if (!groupSessions.length) return;

    showConfirmModal(
        "Stop all agents",
        `Stop ${killCount(groupSessions.length).agents} in "${groupName.startsWith('wf:') ? groupName.slice(3) : keyLabel(groupName)}"? ${groupSessions.length === 1 ? 'Its process ends' : 'Their processes end'} now. ${whatStaysKill(groupSessions)} ${killCount(groupSessions.length).note}`,
        async () => {
            const release = await importOnce('./kill_pending.js').then(m => m.markStopping(groupSessions)); // every row says Stopping... from the click, not only the one being killed now (#15431)
            const failed = [];
            for (const s of groupSessions) {
                try {
                    const answer = await killLiveSession(s);
                    if (!answer || answer.error) failed.push(s.session_id);
                } catch (e) {
                    failed.push(s.session_id);
                    console.error(`Failed to kill ${s.name}:`, e);
                }
            }
            release(failed);
            dropKilledRows(groupSessions);
        }, undefined, { label: 'Stop all', danger: true }
    );
}

/** Kill Team's confirmation says what happens to the team's worktree, when it has one (an agent of the team is on a worktree). */
function _teamWorktreeSentence(sessions) {
    const wt = sessions.find(s => s.git_state && s.git_state.is_worktree);
    return wt ? `${worktreeConfirmWords(wt.branch)} ` : '';
}

export async function killBoard(boardName) {
    const boardSessions = state.liveSessions.filter(s => inTeam(s, boardName));
    if (!boardSessions.length) return;
    // Through the Coral Hub a whole team needs Launch (#3433, #3443): say why (a toast, as Delete
    // does) instead of a refusal per agent.
    const blocked = launchBlockedReason(splitKey(boardName).server);
    if (blocked) { showToast(blocked, true); return; }

    showConfirmModal(
        "Stop agents",
        `Stop ${killCount(boardSessions.length).agents} in "${keyLabel(boardName)}"? ${boardSessions.length === 1 ? 'Its process ends' : 'Their processes end'} now. ${whatStaysKill(boardSessions)} ${_teamWorktreeSentence(boardSessions)}${killCount(boardSessions.length).note}`,
        async () => {
            // The whole team through the team route, so the team is marked stopped as an API kill does (its worktree is then not "in use" in the kept-worktrees list); its one answer carries the worktree.
            let worktree = null;
            try {
                const { ok, answer } = await killLiveTeam(boardName, boardSessions);
                if (!ok) showToast((answer && answer.error) || 'Could not stop the team', true);
                else if (answer && answer.worktree && answer.worktree.state && answer.worktree.state !== 'none') worktree = answer.worktree;
                if (ok) showToast(`Stopped ${killCount(boardSessions.length).agents} in "${keyLabel(boardName)}". The team stays; Remove team is on its page.`);
            } catch (e) {
                console.error(`Failed to stop team ${boardName}:`, e);
                showToast('Could not stop the team', true);
            }
            showWorktreeNotice(worktree); // an error is an alert, the rest a status; a kept one stays on screen with its path (#6818)
            dropKilledRows(boardSessions);
        }, undefined, { label: 'Stop agents', danger: true }
    );
}

export async function shareAgentTeam(boardName) {
    const tmpl = await (await importOnce('./team_template_build.js')).templateFromBoard(boardName);
    if (!tmpl) {
        showToast("No agents found on this board", "error");
        return;
    }

    const template = {
        version: 1,
        type: "coral-team-templates",
        templates: [tmpl],
    };

    const jsonStr = JSON.stringify(template, null, 2);
    const filename = `coral-team-${keyLabel(boardName).replace(/[^a-zA-Z0-9-_]/g, "_")}.json`;

    // Show export modal with JSON content
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content dlg-form">
            <div class="modal-header">
                <h3>Export Team: ${escapeHtml(keyLabel(boardName))}</h3>
                <p style="color:var(--text-secondary);font-size:var(--fs-md);margin:6px 0 0">${tmpl.agents.length} agent${tmpl.agents.length === 1 ? '' : 's'}. This file starts the same team on any Coral: in New team, choose Import a template. Copy it or download it.</p>
            </div>
            <div class="modal-body">
                <textarea readonly class="form-textarea-readonly">${escapeHtml(jsonStr)}</textarea>
            </div>
            <div class="modal-actions modal-footer">
                <button class="btn" data-action="close">Close</button>
                <button class="btn" data-action="download">Download</button>
                <button class="btn btn-primary" data-action="copy">Copy to Clipboard</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const close = registerDialog(modal);
    modal.addEventListener('click', (e) => {
        const action = e.target.dataset?.action;
        if (action === 'close') { close(); return; }
        if (action === 'copy') {
            navigator.clipboard.writeText(jsonStr).then(() => showToast('Copied to clipboard'));
            return;
        }
        if (action === 'download') {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast(`Downloaded ${filename}`);
        }
    });
}

export function saveTeamFromSidebar(boardName) {
    showPromptModal('Save team template', 'Name. Saves: members, models, thinking, modes, working mode, instructions. Not skills.', keyLabel(boardName), async (templateName) => {
        const tmpl = await (await importOnce('./team_template_build.js')).templateFromBoard(boardName);
        if (!tmpl) {
            showToast("No agents found on this board", "error");
            return;
        }
        tmpl.name = templateName;

        // into the list the server has now (#4423)
        try {
            const { raw } = await updateSettingList("saved_team_templates", list => upsertByName(list, [tmpl]),
                { local: parseList(state.settings.saved_team_templates, []) });
            state.settings.saved_team_templates = raw;
        } catch {
            showToast("Could not save the template", "error");
            return;
        }
        showToast(`Saved template "${templateName}" (${tmpl.agents.length} agents)`);
    });
}

/** Wake team found members that were ended (Kill all, or their own exit) and says so: ask once to resume them all, each in its own folder with its earlier chat, on the team's own computer. */
async function offerResumeEnded(boardName, ended) {
    if (!Array.isArray(ended) || !ended.length) return;
    const { endedSessionOf, resumeEndedAgents, resumeEndedWords, resumeEndedQuestion } = await importOnce('./resume_ended.js');
    const members = ended.map(endedSessionOf).filter(Boolean);
    if (!members.length) return;
    const { server, name: board } = splitKey(boardName);
    showConfirmModal('Resume agents', resumeEndedQuestion(keyLabel(boardName), members.map(m => m.name)), async () => {
        const result = await resumeEndedAgents(server, ended, board);
        showToast(resumeEndedWords(keyLabel(boardName), result), result.failed.length > 0);
    }, undefined, { danger: false, label: 'Resume agents' });
}

/** What a Wake that started some of the team and not all says: who did not start, and the first reason in the server's words (#14172). Plain text. */
export function teamWakeFailureWords(team, failed) {
    const name = f => String(f.name || 'An agent');
    const first = failed[0];
    const rest = failed.slice(1).map(name);
    return `Team "${team}" is only partly awake. ${name(first)} did not start${first.error ? `: ${String(first.error)}` : ''}${rest.length ? `. Also not started: ${rest.join(', ')}` : ''}.`;
}

export function toggleTeamSleep(boardName, action) {
    const doIt = async () => {
        try {
            const resp = await teamFetch(boardName, n => `/api/sessions/live/team/${encodeURIComponent(n)}/${action}`, { method: 'POST' });
            const data = await resp.json().catch(() => ({}));
            // The route answers 200 with ok: false when it did nothing (no sessions on that board): that is a refusal to say, not a team that is awake (#12417: Sleep team "did nothing" and said nothing).
            if (!resp.ok || data.ok === false) {
                showToast(data.error || data.message || `Could not ${action} the team (HTTP ${resp.status})`, true);
                if (action === 'wake') offerResumeEnded(boardName, data.ended); // members Kill all ended: one click brings them back (#14208)
                return;
            }
            const sleeping = !!data.sleeping;
            const failed = Array.isArray(data.failed) ? data.failed.filter(f => f && typeof f.session_id === 'string') : []; // members whose terminal did not start (#14172): they stay asleep on the page
            const failedIds = new Set(failed.map(f => f.session_id));
            for (const s of state.liveSessions) {
                // Team wake leaves archived agents asleep (#3030).
                if (inTeam(s, boardName) && !s.archived && !failedIds.has(s.session_id)) s.sleeping = sleeping;
            }
            importOnce('./team_waking.js').then(m => m.noteTeamSleep(boardName, sleeping)).catch(() => {}); // the team page's status counts the agents that have reported since a Wake and says Asleep after a Sleep (#10052, #10359); loaded here, not at start (page weight)
            redrawLiveList();
            if (failed.length) { showToast(teamWakeFailureWords(keyLabel(boardName), failed), true); return; }
            showToast(sleeping ? `Team "${keyLabel(boardName)}" is now sleeping` : `Team "${keyLabel(boardName)}" is awake`);
        } catch (e) {
            showToast('Failed to toggle team sleep', true);
        }
    };
    if (action === 'sleep') {
        showConfirmModal('Sleep team', `Put all agents on "${keyLabel(boardName)}" to sleep? Their chats stay, and Wake team starts them again.`, doIt, undefined, { danger: false, label: 'Sleep team' });
    } else {
        doIt();
    }
}
