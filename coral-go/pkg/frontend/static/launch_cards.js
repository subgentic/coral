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
const checkTeams = () => importOnce('./home_goal.js').then(m => m.refreshGoalCard()).catch(() => {}); // a failed read leaves the plain line
// Not part of the page's start (#13079, page_weight_browser: the module and the teams read were two more requests at start). The read is made once the page's own requests have gone quiet for GOAL_QUIET_MS, however
// long they take (a slow runner or a slow answer holds it back; a fixed delay did not, #13087's INFO), and once however often the card is drawn.
const GOAL_QUIET_MS = 1000, GOAL_LATEST_MS = 5000; // steady polling never goes quiet: the read is made at most GOAL_LATEST_MS after the card is drawn whatever the requests
let checkPending = false;
function whenRequestsQuiet(fn) {
    let timer = 0, latest = 0, po = null, done = false;
    const fire = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(latest); if (po) po.disconnect(); fn(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(fire, GOAL_QUIET_MS); };
    try { po = new PerformanceObserver(arm); po.observe({ type: 'resource' }); } catch { po = null; } // every finished request restarts the wait
    latest = setTimeout(fire, GOAL_LATEST_MS);
    arm();
}
const checkTeamsSoon = () => { if (checkPending) return; checkPending = true; whenRequestsQuiet(() => { checkPending = false; checkTeams(); }); };
export { checkTeamsSoon as refreshGoalCardSoon };
if (typeof document !== 'undefined') document.addEventListener('coral:welcome-built', checkTeamsSoon);
export const goalDesc = () => (noTeam ? GOAL_NO_TEAM_DESC : LAUNCH_CARDS.find(c => c.key === 'goal').desc);
export function setNoTeam(v) {
    noTeam = !!v;
    for (const el of document.querySelectorAll('[data-goal-desc]')) el.textContent = goalDesc();
}

