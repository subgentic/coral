// What a run of the task queue's lines says (#7183): counts in words, never the lines' command text.
import assert from 'node:assert/strict';
process.env.CORAL_TELEMETRY_DISABLED = '1'; // a unit test starts no Coral; the opt-out stays on in case a line of it ever does (the CI runners census, #7183)
import { queueEvent, queueRunWords } from '../../coral-go/pkg/frontend/static/board_queue_words.js';

const L = {
    assigned: "@fe [Task #1 (high)] Build the Goals view — assigned to you, run 'coral-board task claim 1' to start",
    avail: "You have tasks available — run 'coral-board task claim' to start",
    claimed: '[Task #2 claimed by qa] Test it',
    review: "@orch [Task #2 in review] qa submitted a candidate. Complete it with 'coral-board task complete 2', or delegate it: coral-board task review 2 --to ...",
    done: '[Task #4 completed by fe] Done',
    rejected: '[Task #5 rejected by orch] needs work',
};
assert.deepEqual(queueEvent(L.assigned), { kind: 'created', id: '1', by: '' });
assert.equal(queueEvent(L.avail).kind, 'ignore');
assert.deepEqual(queueEvent(L.claimed), { kind: 'claimed', id: '2', by: 'qa' });
assert.equal(queueEvent(L.review).kind, 'review'); assert.equal(queueEvent(L.review).id, '2');
assert.deepEqual(queueEvent(L.done), { kind: 'finished', id: '4', by: 'fe' });
assert.equal(queueEvent(L.rejected).kind, 'sent back');
assert.equal(queueEvent('something else entirely').kind, 'other');

const four = [1, 2, 3, 4].map(n => `@x [Task #${n} (low)] Title ${n} — assigned to you, run 'coral-board task claim ${n}' to start`);
assert.equal(queueRunWords([...four, L.claimed, L.review, L.done]), '4 tasks created, 1 claimed, 1 in review, 1 finished', 'the audit\'s own example');
assert.equal(queueRunWords([L.avail, ...four]), '4 tasks created', 'the reminder to agents is not counted');
assert.equal(queueRunWords([L.claimed, L.claimed.replace('#2', '#3')]), 'qa took #2; qa took #3', 'a few claims say who took which (#10604)');
assert.equal(queueRunWords([L.claimed, L.claimed.replace('#2', '#3'), L.claimed.replace('#2', '#5'), L.claimed.replace('#2', '#6'), L.claimed.replace('#2', '#7')]), '5 tasks claimed', 'more than four are counted');
assert.equal(queueRunWords([L.assigned, L.claimed.replace('#2', '#1'), L.done.replace('#4', '#1')]), '#1 created; qa took #1; fe finished #1', 'the three lines of one task, named');
assert.equal(queueRunWords([L.claimed, L.review, L.claimed]), 'qa took #2; #2 in review', 'the same line twice is said once');
assert.equal(queueRunWords([L.claimed]), 'qa took #2', 'one claim says who took it');
assert.equal(queueRunWords([L.claimed, L.done]), 'qa took #2; fe finished #4', 'a claim and a finish, each by its own agent');
assert.equal(queueRunWords([L.assigned]), 'Task #1 created');
assert.equal(queueRunWords([L.done]), 'fe finished #4', 'one finish says who finished it');
assert.equal(queueRunWords([L.avail]), 'Coral told the agents that tasks are waiting');
assert.equal(queueRunWords([L.avail, L.avail]), 'Coral told the agents that tasks are waiting');
assert.equal(queueRunWords([]), '');
assert.ok(!/coral-board|run '/.test(queueRunWords([...four, L.review, L.done, L.rejected])), 'no command text in a label');
console.log('board_queue_words: ok');
