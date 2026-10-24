/* The Goals switch on a board's header says how many goals are open (#7252, UI/UX's #7249): "Goals 3". The count comes from the /ws/coral feed's goals_brief (goals_feed.js): nothing is read from a route.
 * A board on this computer only (the Goals face is not drawn through the Hub). No text from a goal is shown here, only a number. */
import { splitKey, LOCAL_SERVER } from './server_base.js';
import { onGoalsSeq, goalsOpenOf } from './goals_feed.js';
import * as W from './goal_words.js';

let project = '';
const bare = () => { const k = splitKey(project); return k.server === LOCAL_SERVER ? k.name : ''; };

function paint() {
    const b = document.getElementById('mb-face-goals'); if (!b) return;
    const text = W.goalsToggleText(project ? goalsOpenOf(bare()) : 0);
    if (b.textContent !== text) b.textContent = text;
    if (b.title !== W.goalsToggleTitle) b.title = W.goalsToggleTitle;
}

/** The board whose header the switch is on (null: none, or one the Goals face is not drawn for). */
export function trackBoardGoals(p) {
    project = p || ''; paint();
}

onGoalsSeq((board) => { if (project && board === bare()) paint(); });
