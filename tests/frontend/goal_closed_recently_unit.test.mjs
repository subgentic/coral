// #17608 (QA's SHOULD on #17284): a closed goal's page asks about uncommitted work only for a week after it was closed.
import assert from 'node:assert/strict';
import { closedRecently, UNCOMMITTED_ASK_DAYS } from '../../coral-go/pkg/frontend/static/goal_closed_words.js';

const now = Date.parse('2026-11-16T12:00:00Z'), day = 86400000;
const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();
assert.equal(UNCOMMITTED_ASK_DAYS, 7);
assert.equal(closedRecently({ updatedAt: at(1) }, now), true, 'closed yesterday: still asked');
assert.equal(closedRecently({ updatedAt: at(6.9) }, now), true, 'inside the week');
assert.equal(closedRecently({ updatedAt: at(8) }, now), false, 'closed eight days ago: not asked');
assert.equal(closedRecently({ updatedAt: at(90) }, now), false, 'an old closed goal does not keep asking');
assert.equal(closedRecently({ updatedAt: '' }, now), true, 'no readable time never hides the line');
assert.equal(closedRecently({}, now), true);
console.log('PASS closed goals ask about uncommitted work for a week');
