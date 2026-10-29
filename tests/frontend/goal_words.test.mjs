// The Goals view's words (#7113): states, the rollup sentence and its one-task and no-task forms, counts, the filter announcement and the empty and failed lines.
import assert from 'node:assert/strict';
import * as W from '../../coral-go/pkg/frontend/static/goal_words.js';

assert.deepEqual(W.FILTERS, ['all', 'active', 'blocked', 'proposed', 'done', 'dropped']);
assert.equal(W.filterLabel('blocked'), 'Blocked'); assert.equal(W.filterLabel('all'), 'All');

assert.equal(W.stateWord({ state: 'active' }), 'Active');
assert.equal(W.stateWord({ state: 'proposed' }), 'Proposed');
assert.equal(W.stateWord({ state: 'done' }), 'Done'); assert.equal(W.stateWord({ state: 'dropped' }), 'Dropped');
assert.equal(W.stateWord({ state: 'blocked', blockedOn: 'the Operator' }), 'Blocked: the Operator', 'named: on whom');
assert.equal(W.stateWord({ state: 'blocked', blockedOn: '  ' }), 'Blocked', 'nothing named: Blocked alone');
assert.equal(W.stateWord({ state: 'blocked' }), 'Blocked');
assert.equal(W.stateWord({ state: 'ODD_state' }), 'Odd_state', 'an unknown state is shown, not hidden');
assert.equal(W.stateWord(null), '');

assert.equal(W.taskStateWord('completed'), 'Done'); assert.equal(W.taskStateWord('skipped'), 'Done');
assert.equal(W.taskStateWord('in_progress'), 'Active'); assert.equal(W.taskStateWord('review_pending'), 'Active');
assert.equal(W.taskStateWord('blocked'), 'Blocked'); assert.equal(W.taskStateWord('parked'), 'Blocked');
assert.equal(W.taskStateWord('pending'), 'Queued'); assert.equal(W.taskStateWord('draft'), 'Queued');
assert.equal(W.taskStateWord('some_new_state'), 'Some new state');


assert.deepEqual(W.rollupShares({ done: 5, active: 2, blocked: 1, queued: 2 }), { done: 0.5, active: 0.2, blocked: 0.1 });
assert.deepEqual(W.rollupShares({}), { done: 0, active: 0, blocked: 0 });


assert.equal(W.filterAnnouncement('blocked', 1), 'Showing 1 blocked goal'); assert.equal(W.filterAnnouncement('active', 2), 'Showing 2 active goals');
assert.equal(W.filterAnnouncement('all', 5), 'Showing all 5 goals'); assert.equal(W.filterAnnouncement('all', 1), 'Showing all 1 goal');
assert.equal(W.filterAnnouncement('dropped', 0), 'No dropped goals'); assert.equal(W.filterAnnouncement('all', 0), 'No goals yet');
assert.deepEqual(W.filteredEmpty('dropped', 4), { text: 'No dropped goals', action: 'Show all 4' });

assert.match(W.noGoalsText, /^No goals yet\. A goal says what the team is for and when it is done; tasks belong to it\.$/);
assert.equal(W.failedText('timed out'), 'Goals could not be read: timed out'); assert.equal(W.failedText(''), 'Goals could not be read');
assert.equal(W.asOfText('14:32'), 'as of 14:32'); assert.equal(W.asOfText(''), '');
assert.equal(W.driverLine('Orchestrator', 'today 14:32'), 'Driver: Orchestrator · today 14:32');
assert.equal(W.driverLine('', 'Oct 17'), 'Oct 17'); assert.equal(W.driverLine('Dev', ''), 'Driver: Dev'); assert.equal(W.driverLine('', ''), '');

const goals = [{ state: 'active' }, { state: 'active' }, { state: 'blocked', blockedOn: 'the Operator' }, { state: 'done' }, { state: 'blocked' }, { state: 'weird' }];
assert.deepEqual(W.filterCounts(goals), { all: 6, active: 2, blocked: 2, proposed: 0, done: 1, dropped: 0 }, 'an unknown state counts in All only');
assert.equal(W.keepsGoal('all', goals[5]), true); assert.equal(W.keepsGoal('blocked', goals[2]), true); assert.equal(W.keepsGoal('done', goals[2]), false);
assert.equal(W.errorWords('goal_title_required', 'x'), 'A goal needs a title.'); assert.equal(W.errorWords('goal_driver_unknown', ''), 'That driver is not on this board.');
assert.equal(W.errorWords('some_new_code', 'The server says this'), 'The server says this', 'an unknown code shows the server\'s sentence'); assert.equal(W.errorWords('', ''), 'try again');
assert.equal(W.showMoreText(120), 'Show 50 more'); assert.equal(W.showMoreText(20), 'Show 20 more'); assert.equal(W.showMoreText(0), 'Show 0 more');
assert.equal(W.tasksShownText(100, 120), 'Showing 100 of 120 tasks');
assert.equal(W.closedWithOpenText(2), 'Closed with 2 tasks still open. They stay open until someone finishes or moves them.'); assert.equal(W.closedWithOpenText(1), 'Closed with 1 task still open. They stay open until someone finishes or moves them.');
assert.equal(W.stateWord({ state: 'blocked', blockedOn: 'the Operator' }), 'Blocked: the Operator'); assert.equal(W.stateWord({ state: 'blocked' }), 'Blocked');
assert.equal(W.readyToClose({ state: 'active', rollup: { done: 3 } }), true); assert.equal(W.readyToClose({ state: 'active', rollup: {} }), false, 'no tasks'); assert.equal(W.readyToClose({ state: 'active', rollup: { done: 3, queued: 1 } }), false); assert.equal(W.readyToClose({ state: 'blocked', rollup: { done: 3 } }), false);
assert.deepEqual(W.closeWarning({ done: 2, active: 1, queued: 2 }), { head: '3 of its 5 tasks are still open (1 active, 2 queued).', text: ' They stay open and stay linked to this goal; nothing is stopped. A closed goal takes no new tasks.' }); assert.equal(W.closeWarning({ done: 2, queued: 1 }).head, '1 of its 3 tasks is still open (1 queued).');
assert.equal(W.closedAsText('done', 0), 'Closed as done.'); assert.equal(W.closedAsText('dropped', 2), 'Closed as dropped. 2 tasks are still open.'); assert.equal(W.closedAsText('dropped', 1), 'Closed as dropped. 1 task is still open.');
assert.equal(W.allDoneLine(3), 'All 3 tasks are done.'); assert.equal(W.allDoneLine(1), 'All 1 task is done.'); assert.equal(W.allDoneAsk('X works'), 'Done when: X works. Is that true?'); assert.equal(W.allDoneAsk(''), 'Is that true?');
assert.equal(W.isOpenGoal({ state: 'blocked' }), true); assert.equal(W.isClosedGoal({ state: 'dropped' }), true); assert.equal(W.isOpenGoal({ state: 'done' }), false);
assert.equal(W.allDoneSaid(3, 'Ship it'), 'All 3 tasks of Ship it are done'); assert.equal(W.allDoneSaid(1, 'A'), 'All 1 task of A is done'); assert.equal(W.closeReasonHint, '300 characters at most.');
// #11004: the line "Copy for an agent" copies
assert.equal(W.agentBriefLine({ id: 65, title: 'Fast, reliable releases' }), 'Goal #65 (Fast, reliable releases): run coral-board goal brief 65');
assert.equal(W.agentBriefLine({ id: 7, title: '' }), 'Goal #7: run coral-board goal brief 7', 'no title: no empty brackets');
assert.equal(W.agentBriefLine({ id: 8, title: 'a\n  b\tc' }), 'Goal #8 (a b c): run coral-board goal brief 8', 'lines and runs of spaces joined');
const longLine = W.agentBriefLine({ id: 9, title: 'x'.repeat(200) });
assert.ok(longLine.includes('\u2026') && longLine.length < 130, 'a long title is cut: ' + longLine.length);
assert.ok(longLine.endsWith(': run coral-board goal brief 9'), 'the command is never cut');
console.log('goal_words: ok');
assert.equal(W.noGoalRowText(1), '1 task has no goal'); assert.equal(W.noGoalRowText(4), '4 tasks have no goal');
