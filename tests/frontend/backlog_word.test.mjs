// #22048: a backlog task (task add --later) is Backlog, never Queued or Waiting; a park with a reason or an end is still Waiting.
import assert from 'node:assert/strict';
import { statusWord, isBacklog } from '../../coral-go/pkg/frontend/static/backlog_word.js';

const ahead = new Date(Date.now() + 3600e3).toISOString();
assert.equal(isBacklog({ parked_reason: 'backlog' }), true);
assert.equal(isBacklog({ parked_reason: 'backlog', parked_until: ahead }), false, 'a backlog reason with an end is an ordinary park');
assert.equal(isBacklog({ parked_reason: 'waiting on the operator' }), false);
assert.equal(isBacklog(null), false);
assert.equal(statusWord({ status: 'pending', parked_reason: 'backlog' }), 'Backlog');
assert.equal(statusWord({ status: 'pending', parked_reason: 'waiting on the operator' }), 'Waiting');
assert.equal(statusWord({ status: 'pending' }), 'Queued');
assert.equal(statusWord({ status: 'completed', parked_reason: 'backlog' }), 'Done', 'a finished task is Done');
console.log('backlog_word: ok');
