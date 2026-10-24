/* The Goals switch on a board's header says how many goals are open and whether one waits on the person (#7252, UI/UX's #7249): "Goals 3 · 1 waiting". The open count comes from the /ws/coral feed's goals_brief
 * (goals_feed.js); the waiting count is read from the existing goals route (the blocked goals with a decision to make), once when a board opens and again when its seq moves. A board on this computer only
 * (the Goals face is not drawn through the Hub). No text from a goal is shown here, only numbers. */
import { boardFetch, splitKey, LOCAL_SERVER } from './server_base.js';
import { onGoalsSeq, goalsOpenOf } from './goals_feed.js';
import { toGoalList } from './goals_adapter.js';
import * as W from './goal_words.js';

let project = '', waiting = 0, reading = 0;
const bare = () => { const k = splitKey(project); return k.server === LOCAL_SERVER ? k.name : ''; };

function paint() {
    const b = document.getElementById('mb-face-goals'); if (!b) return;
    const text = W.goalsToggleText(project ? goalsOpenOf(bare()) : 0, waiting);
    if (b.textContent !== text) b.textContent = text;
    if (b.title !== W.goalsToggleTitle) b.title = W.goalsToggleTitle;
}

async function readWaiting() {
    const p = project, n = ++reading;
    if (!p || !bare()) return;
    try {
        const r = await boardFetch(p, '/goals?state=blocked');
        if (!r.ok) throw new Error(String(r.status));
        const count = W.waitingGoals(toGoalList(await r.json()).goals).length;
        if (p === project && n === reading) { waiting = count; paint(); }
    } catch { if (p === project && n === reading) { waiting = 0; paint(); } }
}

/** The board whose header the switch is on (null: none, or one the Goals face is not drawn for). */
export function trackBoardGoals(p) {
    project = p || ''; waiting = 0; paint();
    if (project) readWaiting();
}

onGoalsSeq((board) => { if (project && board === bare()) { paint(); readWaiting(); } });
