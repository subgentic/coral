/* The home screen's New goal card (#13012, the Operator: Open folder became New goal, and a home with no team has to say so). Lazy: launch_cards.js loads it when the welcome page is built and when the card is pressed.
 * Teams are counted as the Inbox's New goal counts them (this computer's boards, and on a Hub every online computer's), by the checked read: a refusal is an error, not an empty list. Never a goal with no owner: with no team the card explains and offers Start a team. */
import { fetchProjectsChecked } from './board_fetch.js';
import { teamLabel } from './server_status.js';
import { importOnce } from './import_once.js';
import { setNoTeam } from './launch_cards.js';
import { showConfirmModal } from './confirm_dialog.js';

async function teams() {
    try { return (await fetchProjectsChecked()).map(p => ({ key: String(p.project), label: teamLabel(p.project, p.board_label || '') })).filter(t => t.key).sort((a, b) => a.label.localeCompare(b.label)); } catch { return null; } // null: could not tell. A refusal, an error body or an unreadable computer is never "no teams" (the checked read throws on each): the card keeps its plain line and pressing it says the read failed (#13012, UI Reviewer)
}

/** Put the card's line right (no team, or the plain one); a failed read leaves it as it was. */
export async function refreshGoalCard() { const list = await teams(); if (list) setNoTeam(list.length === 0); }

/** The card was pressed. */
export async function startGoalFromHome() {
    const list = await teams();
    if (list === null) { const { showToast } = await importOnce('./notifications.js'); showToast('Could not read your teams. Try again.', true); return; }
    setNoTeam(list.length === 0);
    if (!list.length) {
        showConfirmModal('No team to give a goal to', 'A goal goes to a team. Start a team first, then give it the goal.', () => { window.showLaunchModal(); window._selectLaunchType('team'); }, null, { label: 'Start a team', danger: false });
        return;
    }
    const GV = await importOnce('./goals_view.js');
    GV.openCreate({ project: list[0].key, teams: list, onCreated: () => { document.dispatchEvent(new CustomEvent('coral:goal-created-from-home')); } });
}
