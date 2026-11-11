/* The goal page's words about who closed a goal and what Close and Reopen do (#15244, walk 12). Its own module: goal_words.js is in the start bundle, this loads with the goal page. */
import * as W from './goal_words.js';

export const reopenedText = 'Reopened. The team read it on the board, and its open tasks and agents carry on as they were.';
/** What closing does, said in the Close dialog whether or not tasks are open (#15244, walk 12 M2). */
export const closeEffectText = 'Closing posts a line on the board for the team. It stops no agent and no task. You can reopen the goal.';
/** Who closed a goal, in words for its page: "Closed as done by you" or "Closed as done by Orchestrator", with the reason; '' for an open goal. The Operator's own name reads as "you". */
export function closedByLine(g) {
    if (!W.isClosedGoal(g)) return '';
    const by = String((g && g.closedBy) || '').trim(), word = String(g.state).toLowerCase() === 'dropped' ? 'dropped' : 'done';
    const who = by === 'Operator' ? ' by you' : by ? ` by ${by}` : '';
    const why = String((g && g.closedReason) || '').trim();
    return `Closed as ${word}${who}.${why ? ` Reason: ${why}` : ''}`;
}
/** What Not yet does on a goal that looks done, in a line beside its buttons (a phone shows no tooltip). */
export const looksDoneText = 'All its tasks are done. Close goal finishes it. Not yet keeps it open and hides this reminder until another task is added.';
