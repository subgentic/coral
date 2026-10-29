import { plural } from './format.js';
/* The Goals view's words (#7113, UI/UX's #7091 design): a goal's state, the rollup of its tasks, the counts and the empty, filtered-empty and failed lines as a person says them, not as the
 * routes store them. Pure functions (node-tested like job_words.js); the numbers come from the routes' rollup, never from counting rows in the page. No imports.
 * The state words are capitalised and lower-cased on use: the icon scanner reads a quoted lower-case word ("done", "block") as a Material icon name (icon_subset). */
const STATES = ['Active', 'Blocked', 'Proposed', 'Done', 'Dropped'];
/** The filter chips, in order: All, then the five states. */
export const FILTERS = ['All', ...STATES].map(w => w.toLowerCase());

const word = (s) => { const t = String(s || '').trim(); return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : ''; };

/** The chip's label for a filter: "All", "Active", ... */
export const filterLabel = (f) => word(f);

/** A goal's state as the card says it: "Blocked on the Operator" when the routes name who or what it waits for, "Blocked" alone when they do not, else the state's word. Unknown states come back as sent, capitalised. */
export function stateWord(goal) {
    const s = word(goal && goal.state);
    if (s === 'Blocked') {
        const on = String((goal && goal.blockedOn) || '').trim();
        return on ? `Blocked: ${on}` : 'Blocked';
    }
    return s;
}

/** A task's state, one word each (a task is blocked, never "blocked on" in a row). */
export const taskStateWord = (state) => {
    const s = String(state || '').toLowerCase();
    const done = ['completed', 'skipped'], active = ['in_progress', 'review_pending'], blocked = ['blocked', 'parked'], queued = ['pending', 'draft'];
    if (done.includes(s)) return 'Done';
    if (active.includes(s)) return 'Active';
    if (blocked.includes(s)) return 'Blocked';
    if (queued.includes(s)) return 'Queued';
    return word(s.replace(/_/g, ' '));
};

/** A task's state as the team page's tables say it (#7453): Queued, In progress, In review, Blocked, Done; `review` is a task with its completion review pending. */
export function taskStatusWord(status, review) {
    const s = String(status || '').toLowerCase();
    if (['completed', 'skipped'].includes(s)) return 'Done';
    if (review || s === 'review_pending') return 'In review';
    if (s === 'in_progress') return 'In progress';
    if (['blocked', 'parked'].includes(s)) return 'Blocked';
    if (['pending', 'draft'].includes(s)) return 'Queued';
    return word(s.replace(/_/g, ' '));
}
/** The class that colours a state's dot (the goal chips' classes, shared). */
export const statusClass = (w) => `goal-state-task-${({ 'In progress': 'active', 'In review': 'active' }[w] || w).toLowerCase()}`;


/** What the page's status region says once after a chip is pressed: "Showing all 5 goals", "Showing 1 blocked goal", "No dropped goals". */
export function filterAnnouncement(which, count) {
    if (!count) return which === 'all' ? 'No goals yet' : `No ${which} goals`;
    return which === 'all' ? `Showing all ${plural(count, 'goal', 'goals')}` : `Showing ${count} ${which} ${count === 1 ? 'goal' : 'goals'}`;
}

/** The list's line when a filter shows nothing, and the button that clears it: { text: "No dropped goals", action: "Show all 4" }. */
export const filteredEmpty = (which, total) => ({ text: `No ${which} goals`, action: `Show all ${total}` });

/** The list's line when the board has no goals at all. */
export const noGoalsText = 'No goals yet. A goal says what the team is for and when it is done; tasks belong to it.';

/** The button under a long task list: "Show 50 more" (never more than the page, never more than is left). */
export const showMoreText = (left, page = 50) => `Show ${Math.min(page, Math.max(0, left))} more`;
/** Said once after it: "Showing 100 of 120 tasks". */
export const tasksShownText = (shown, total) => `Showing ${shown} of ${total} tasks`;
/** The goal page's count of the tasks made as follow-ups of another task that are still open (#7816, the server's follow_ups_open). */
export const followUpsOpenText = (n) => (n === 1 ? '1 follow-up open' : `${n} follow-ups open`);
/** Under the list when the route sent fewer tasks than the goal's rollup counts (its cap): honest about it, and where the rest are. */

/** One line over a goal's open tasks when no agent on this computer works on some of them (said once, not on every row): "Nobody is working on these yet", or "Nobody is working on 2 of these yet". */

/** The failed read: "Goals could not be read: <reason>", and the line that marks a list kept on screen from before: "as of 14:32". */
export const failedText = (reason) => { const r = String(reason || '').trim(); return r ? `Goals could not be read: ${r}` : 'Goals could not be read'; };
export const asOfText = (when) => (when ? `as of ${when}` : '');

/** "Driver: <agent> · <when>", leaving out what it does not have. */
export function driverLine(driver, when) {
    const d = String(driver || '').trim();
    return [d ? `Driver: ${d}` : '', when || ''].filter(Boolean).join(' · ');
}

/** What a refused create or change says, by the route's error code (the code is a word, the sentence is the server's): our own words where the code is known, the server's sentence otherwise. */
const ERRORS = { goal_title_required: 'A goal needs a title.', goal_text_too_long: 'That is too long: shorten it and try again.', goal_driver_unknown: 'That driver is not on this board.', goal_bad_state: 'That state is not one a goal can have.', goal_not_found: 'That goal is no longer on this board.', goal_closed: 'That goal is closed.', goal_already_closed: 'That goal is already closed.', goal_blocked_on_required: 'A blocked goal says who it waits for.', goal_required: 'This board needs a goal on every task.', local_only: 'This can only be done on this computer.' };
export const errorWords = (code, sentence) => ERRORS[code] || String(sentence || '').trim() || 'try again';

export const driverHelp = 'Driver: the agent who looks after it';

/** A goal that is Closed with tasks still open, said on its page (the close answers with the count, and does not touch them). */
export const closedWithOpenText = (n) => `Closed with ${plural(n, 'task', 'tasks')} still open. They stay open until someone finishes or moves them.`;

/** The note under the header when the board refuses tasks without a goal. */
export const requireGoalNote = 'Tasks without a goal are refused on this board (require a goal is on).';
/** The line that says the other boards are elsewhere, drawn only while the Hub is connected. */
export const otherBoardsNote = 'Other boards and computers: in Coral Hub';

/** The bar's accessible name is the sentence; this is the part widths a CSS bar needs (done, active, blocked as shares of the task total; queued is the track). */
export function rollupShares(rollup) {
    const r = rollup || {};
    const n = (x) => Math.max(0, Number(x) || 0);
    const total = n(r.done) + n(r.active) + n(r.blocked) + n(r.queued);
    if (!total) return { done: 0, active: 0, blocked: 0 };
    return { done: n(r.done) / total, active: n(r.active) / total, blocked: n(r.blocked) / total };
}

/** Which goals a filter keeps, and how many each chip counts. */
export const keepsGoal = (which, goal) => which === 'all' || String(goal && goal.state || '').toLowerCase() === which;
export function filterCounts(goals) {
    const out = Object.fromEntries(FILTERS.map(f => [f, 0]));
    for (const g of goals || []) { out.all++; const s = String(g && g.state || '').toLowerCase(); if (s in out) out[s]++; }
    return out;
}


/** The same fact as the Goals table's last row (#7717): it is a row of the table, which opens the team's Tasks. */
export const noGoalRowText = (n) => `${n} ${n === 1 ? 'task has' : 'tasks have'} no goal`;

// Closing a goal, reopening it, and the prompt when every task is done (#7272, UI/UX's #7270).
const openOf = (r) => { const x = r || {}; return ['active', 'blocked', 'queued'].reduce((n, k) => n + Math.max(0, Number(x[k]) || 0), 0); };
const totalOf = (r) => openOf(r) + Math.max(0, Number((r || {}).done) || 0);
/** Open tasks of a rollup (active, blocked, queued) and all its tasks. */
export const openTasksOf = openOf;
export const allTasksOf = totalOf;
/** A goal that can be closed (its state is open) and one that is closed. */
export const isOpenGoal = (goal) => ['proposed', 'active', 'blocked'].includes(String(goal && goal.state || '').toLowerCase());
export const isClosedGoal = (goal) => ['done', 'dropped'].includes(String(goal && goal.state || '').toLowerCase());
/** An active goal with tasks, none of them open: the page asks whether to close it. */
export const readyToClose = (goal) => String(goal && goal.state || '').toLowerCase() === 'active' && totalOf(goal && goal.rollup) > 0 && openOf(goal && goal.rollup) === 0;
export const closeTitle = 'Close this goal?';
export const closeDoneLabel = 'Done: what we wanted is true';
export const closeDroppedLabel = 'Dropped: we are no longer doing it';
export const closeReasonLabel = 'Why (required): a line the agents will see';
export const closeReasonNeeded = 'A reason is needed: the agents read it.';
export const alreadyClosedText = 'It was already closed.';
/** The warning in the Close dialog when tasks are open: "2 of its 5 tasks are still open (2 queued)." and what closing does about them. */
export function closeWarning(rollup) {
    const r = rollup || {}, open = openOf(r), total = totalOf(r);
    const parts = ['active', 'blocked', 'queued'].filter(k => Number(r[k]) > 0).map(k => `${Number(r[k])} ${k}`).join(', ');
    return { head: `${open} of its ${plural(total, 'task', 'tasks')} ${open === 1 ? 'is' : 'are'} still open${parts ? ` (${parts})` : ''}.`, text: ' They stay open and stay linked to this goal; nothing is stopped. A closed goal takes no new tasks.' };
}
export const closedAsText = (state, open) => `Closed as ${state === 'dropped' ? 'dropped' : 'done'}.${open ? ` ${plural(open, 'task', 'tasks')} ${open === 1 ? 'is' : 'are'} still open.` : ''}`;
export const reopenedText = 'Reopened.';
/** The all-done strip: its line, the goal's done-when, the question, and what Not yet does. */
export const allDoneLine = (n) => `All ${plural(n, 'task', 'tasks').replace(/^\d+ /, n === 1 ? '1 ' : `${n} `)} ${n === 1 ? 'is' : 'are'} done.`;
export const allDoneAsk = (doneWhen) => `${doneWhen ? `Done when: ${doneWhen}. ` : ''}Is that true?`;
export const notYetHint = 'Not yet hides this until a task is added.';
export const notYetSaid = 'Hidden until a task is added.';
/** A closed-ready goal's card sentence: the rollup's, and a quiet "ready to close?". */
export const closeReasonHint = '300 characters at most.';
/** Said once, politely, when the all-done strip first appears for a goal. */
export const allDoneSaid = (n, title) => `All ${n} ${n === 1 ? 'task' : 'tasks'} of ${title} ${n === 1 ? 'is' : 'are'} done`;

/** The line the goal page's "Copy for an agent" copies (#11004): the goal's number and title, and the command that briefs an agent on it. The title is cut at 80 characters and its lines joined. */
export function agentBriefLine(goal) {
    const id = goal && goal.id;
    const title = String((goal && goal.title) || '').replace(/\s+/g, ' ').trim();
    const shown = title.length > 80 ? title.slice(0, 79).trimEnd() + '\u2026' : title;
    return `Goal #${id}${shown ? ` (${shown})` : ''}: run coral-board goal brief ${id}`;
}
