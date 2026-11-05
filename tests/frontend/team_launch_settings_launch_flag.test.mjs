// team_launch_settings.js (#13221): the launch's own settings save says launch: true, so the server does not tell the new team's Orchestrator about it (it is how the team starts, and it would be the
// Orchestrator's first message, before its first task). Nothing else about the save changes.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const calls = [];
globalThis.fetch = window.fetch = async (input, init) => {
    const url = new URL(String(input && input.url || input), 'http://127.0.0.1:8420/');
    calls.push({ method: String((init && init.method) || 'GET').toUpperCase(), path: url.pathname, body: init && init.body ? JSON.parse(init.body) : null });
    return Response.json({ ok: true });
};
const { applyTeamBoardSettings } = await importUi('team_launch_settings');
calls.length = 0; // whatever the import fetched

assert.equal(await applyTeamBoardSettings('first-team', null), '', 'nothing to apply, nothing sent');
assert.equal(calls.length, 0);

assert.equal(await applyTeamBoardSettings('first-team', { require_goal: true, cross_team_messaging: false }), '');
const put = calls.find(c => c.method === 'PUT' && /\/settings$/.test(c.path));
assert.ok(put, `no settings save was made: ${JSON.stringify(calls)}`);
assert.equal(put.body.launch, true, 'the launch says the save is its own');
assert.equal(put.body.subscriber_id, 'Operator');
assert.equal(put.body.require_goal, true);
assert.equal(put.body.cross_team_messaging, false);
console.log('team_launch_settings_launch_flag: ok');
process.exit(0);
