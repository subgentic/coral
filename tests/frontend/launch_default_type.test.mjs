// #596: the agent type New agent starts on. The default_agent_type setting; else the newest agent's type on the computer the launch is for (a plain terminal is not one); else Claude, which the
// provider cards move to the first installed agent when Claude is missing (that rung, and the check of step 1 following it, are tested in new_agent_installed_type_browser.test.js).
import assert from 'node:assert/strict';
import { startingAgentType } from '../../coral-go/pkg/frontend/static/launch_default_type.js';

const at = (agent_type, created_at, server) => ({ agent_type, created_at, ...(server ? { server } : {}) });
const codexNewest = [at('claude', '2026-11-01T09:00:00Z'), at('codex', '2026-11-02T09:00:00Z'), at('pi', '2026-10-30T09:00:00Z')];

// rung 1: the setting wins over every agent
assert.equal(startingAgentType('opencode', codexNewest, 'local'), 'opencode', 'the default_agent_type setting comes first');
assert.equal(startingAgentType(' Gemini ', [], 'local'), 'agy', 'an old name of Antigravity in the setting is its type');
// rung 2: the newest agent on that computer
assert.equal(startingAgentType('', codexNewest, 'local'), 'codex', 'no setting: the newest agent\'s type');
assert.equal(startingAgentType(undefined, [...codexNewest].reverse(), 'local'), 'codex', 'the order of the list does not matter, the time does');
assert.equal(startingAgentType('', [at('codex', '2026-11-02T09:00:00Z'), at('terminal', '2026-11-03T09:00:00Z')], 'local'), 'codex', 'a plain terminal is not an agent type to start on');
assert.equal(startingAgentType('', [at('codex', '2026-11-02T09:00:00Z', 'laptop'), at('pi', '2026-11-01T09:00:00Z')], 'local'), 'pi', 'only the agents of the computer the launch is for');
assert.equal(startingAgentType('', [at('codex', '2026-11-02T09:00:00Z', 'laptop')], 'laptop'), 'codex', 'another computer\'s own newest agent');
assert.equal(startingAgentType('', [at('codex', 'not a time'), at('pi', '2026-11-01T09:00:00Z')], 'local'), 'pi', 'a row without a readable time is the oldest');
assert.equal(startingAgentType('', [at('antigravity', '2026-11-01T09:00:00Z')], undefined), 'agy', 'no server means this computer, and an old name is its type');
// rung 3 and 4: Claude, which the provider cards replace with the first installed agent when Claude is missing
assert.equal(startingAgentType('', [], 'local'), 'claude', 'no setting and no agent: Claude');
assert.equal(startingAgentType(null, null, 'local'), 'claude', 'nothing at all: Claude');
assert.equal(startingAgentType('', [null, at('', '2026-11-01T09:00:00Z'), at('terminal', '2026-11-01T09:00:00Z')], 'local'), 'claude', 'rows without an agent type are skipped');
console.log('launch_default_type: ok');
