// The person's own posts on the team Board say "You" (#10718); the id stays Operator, a Hub user's post as the Operator does not.
import assert from 'node:assert/strict';
process.env.CORAL_TELEMETRY_DISABLED = '1';
import { authorLabel } from '../../coral-go/pkg/frontend/static/board_author.js';

assert.equal(authorLabel({ subscriber_id: 'Operator', job_title: 'Operator' }, 'Operator'), 'You');
assert.equal(authorLabel({ subscriber_id: 'dashboard', job_title: 'Operator' }, 'Operator'), 'You');
assert.equal(authorLabel({ subscriber_id: 'Operator', origin: 'hub_operator' }, 'Operator'), 'Operator', 'a Hub user posting as the Operator is not you at this computer');
assert.equal(authorLabel({ subscriber_id: 'abc', job_title: 'Orchestrator' }, 'Orchestrator'), 'Orchestrator');
assert.equal(authorLabel({ subscriber_id: 'abc', job_title: 'Operator' }, 'Operator'), 'Operator', 'an agent titled Operator is not the person');
console.log('ok');
