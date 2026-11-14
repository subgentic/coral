/* "Goal #N closed as done by <agent>" (#15257, Beta walk 12 H1): a goal an agent closed is a row of Needs you with Reopen, so the person sees it and can undo it in one tap. It was first listed and not counted (the welcome notes' rule,
 * #11622): it is no alarm, and the server's needs-you count, the phone push and the Hub projection know nothing of it. A goal the person made is COUNTED in the badge and the sidebar until they dismiss or reopen it (#16753, the
 * Operator: "put it into the needs you"); one an agent proposed is listed only. Dismiss is kept in this browser, keyed by the goal and the time it was closed, so a goal
 * that is reopened and closed again shows again. Lives in its own module: the Inbox sidebar imports it when it is built, never at start. */
import { browserLocal } from './safe_storage.js';
const KEY = 'coral_goal_closed_dismissed', WINDOW_MS = 14 * 864e5, MAX = 100;
const keyOf = (team, g) => `${team}|${g.id}|${g.closed_at || ''}`;
const read = () => { try { const v = JSON.parse(browserLocal.get(KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
const write = list => browserLocal.set(KEY, JSON.stringify(list.slice(-MAX)));

/** Whether the goal was closed as done by an agent (not by the Operator, not unknown) within the last 14 days. */
export const closedByAgent = (g, now = Date.now()) => {
    const by = String((g && g.closed_by) || '').trim(), at = Date.parse(g && g.closed_at);
    return String((g && g.state) || '').toLowerCase() === 'done' && !!by && by !== 'Operator' && Number.isFinite(at) && now - at < WINDOW_MS && now >= at - 6e4;
};

/** Whether the person made the goal (the Operator, or a Hub user): only such a close is counted in Needs you (#16753); an agent closing a goal an agent proposed is listed only. */
export const madeByPerson = g => /^(Operator|hub-user-)/i.test(String((g && g.created_by) || '').trim());

/** The rows: one per such goal not dismissed here. reopen(g) puts the goal back to active; the caller redraws after both it and a dismiss. */
export function closedGoalRows(goals, teamOf, { reopen, dismissed = () => {}, now = Date.now() } = {}) {
    const gone = new Set(read());
    return (goals || []).filter(g => closedByAgent(g, now) && teamOf(g) && !gone.has(keyOf(teamOf(g), g))).map(g => {
        const team = teamOf(g), title = `Goal #${g.id} closed as done by ${String(g.closed_by).trim()}`, text = String(g.closed_reason || '').trim() || String(g.title || '');
        return { goalClosed: g, welcome: { id: `goalclosed:${team}:${g.id}`, title, text, go: 'Reopen', dismiss: true, run: () => reopen(g), onDismiss: () => { write([...read(), keyOf(team, g)]); dismissed(g); } },
            session_id: `goal_closed:${team}:${g.id}`, display_name: title, board_project: '', server: '', waiting_kind: 'goal_done', waiting_summary: text, waiting_since: g.closed_at || '' };
    });
}
