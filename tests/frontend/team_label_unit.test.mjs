// teamLabel (#8774): a team's name in a list that can hold teams of more than one computer. Two teams called alpha on two computers are two rows told apart by their computer; a hub with no remote, or no hub, reads as before.
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', host: 'hub.example' };
const { teamLabel } = await import('../../coral-go/pkg/frontend/static/server_status.js');
const { state } = await import('../../coral-go/pkg/frontend/static/state.js');

state.hub = false; state.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
assert.equal(teamLabel('alpha'), 'alpha', 'no hub: the plain label');
state.hub = true; state.servers = [];
assert.equal(teamLabel('alpha'), 'alpha', 'a hub with no remote: the plain label');
state.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
const local = teamLabel('alpha'), remote = teamLabel('@box-2/alpha');
assert.equal(local, 'alpha · This computer');
assert.match(remote, /^alpha · .*Box Two/, 'the remote one names its computer');
assert.notEqual(local, remote, 'two teams called alpha are told apart');
assert.equal(teamLabel('@box-2/beta'), remote.replace('alpha', 'beta'));
console.log('team_label_unit: ok');
