// spendTeamKeys: the teams the Analytics spend section can read (#8693): through a hub every team's key; through the Cloud Hub only this computer's (its tunnel never carries another computer's board spend).
import assert from 'node:assert/strict';
import { spendTeamKeys } from '../../coral-go/pkg/frontend/static/server_base.js';

const sessions = [
    { session_id: 'a', board_project: 'alpha' },
    { session_id: 'b', board_project: 'alpha' },
    { session_id: 'c', board_project: 'beta', server: 'box-2' },
    { session_id: 'd' },
    null,
];
assert.deepEqual(spendTeamKeys(sessions, false).sort(), ['@box-2/beta', 'alpha'], 'direct or through a self-hosted hub: each team once, a remote one by its key, an agent with no team left out');
assert.deepEqual(spendTeamKeys(sessions, true), ['alpha'], 'through the Cloud Hub the remote team is not offered: its spend cannot be read');
assert.deepEqual(spendTeamKeys(undefined, true), []);
assert.deepEqual(spendTeamKeys([], false, ['quiet', '@box-2/deep']).sort(), ['@box-2/deep', 'quiet'], 'every team with a board is offered, with no agent running (#8811)');
assert.deepEqual(spendTeamKeys(sessions, false, ['alpha', 'quiet']).sort(), ['@box-2/beta', 'alpha', 'quiet'], 'a team with an agent and a board is one entry');
assert.deepEqual(spendTeamKeys([], true, ['quiet', '@box-2/deep']), ['quiet'], 'through the Cloud Hub only this computer\'s boards');
console.log('spend_teams_unit: ok');
