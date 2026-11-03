/* The cards that start something, in one table (#9998): the phone's empty Agents page draws them from here, and the desktop's welcome page (templates/index.html) and the New dialog's chooser
 * (templates/includes/modals.html) carry the same icons, words and order as markup: tests/frontend/launch_cards_census.test.mjs reads all three against this table. The dialog adds Terminal after them, the one extra (written in the census test, which is its only reader). */
import { importOnce } from './import_once.js';
export const LAUNCH_CARDS = [
    { key: 'agent', icon: 'smart_toy', label: 'New agent', desc: 'One agent in a folder you choose.' },
    { key: 'team', icon: 'groups', label: 'New team', desc: 'Launch a team of agents collaborating on a shared board.' },
    { key: 'goal', icon: 'flag', label: 'New goal', desc: 'Give a team an outcome to work toward.' },
];
// Open folder left the home screen's cards for New goal (#13012, the Operator); the New dialog's chooser still has it (markup, after New team; the census reads it there), and the computer's menu has it too.
/** The goal card says, in its own line, when there is no team to give a goal to (the teams the app lists, remote ones on a Hub included: home_goal.js counts them as the Inbox's New goal does). Until that is known it is the plain line. */
export const GOAL_NO_TEAM_DESC = 'No team yet. Start one to give it a goal.';
let noTeam = false;
const checkTeams = () => importOnce('./home_goal.js').then(m => m.refreshGoalCard()).catch(() => {}); // after the page is up; a failed read leaves the plain line
export { checkTeams as refreshGoalCardSoon };
if (typeof document !== 'undefined') document.addEventListener('coral:welcome-built', () => setTimeout(checkTeams, 0));
export const goalDesc = () => (noTeam ? GOAL_NO_TEAM_DESC : LAUNCH_CARDS.find(c => c.key === 'goal').desc);
export function setNoTeam(v) {
    noTeam = !!v;
    for (const el of document.querySelectorAll('[data-goal-desc]')) el.textContent = goalDesc();
}

