// Edit instructions is offered for an agent on this computer's dashboard, not for a terminal and not on a Hub-served dashboard (#10133, Security Reviewer's LOW c).
import assert from 'node:assert/strict';
import { instructionsOffered } from '../../coral-go/pkg/frontend/static/agent_instructions_offer.js';
assert.equal(instructionsOffered({ agent_type: 'claude' }, false), true, 'an agent on a local dashboard');
assert.equal(instructionsOffered({ agent_type: 'codex' }, false), true);
assert.equal(instructionsOffered({ agent_type: 'terminal' }, false), false, 'a terminal has no Behavior prompt');
assert.equal(instructionsOffered({ agent_type: 'claude' }, true), false, 'on a Hub-served dashboard the route is never');
assert.equal(instructionsOffered(null, false), false);
console.log('agent_instructions_offer: ok');
