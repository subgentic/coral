// Add agent's folder for a team (#11083, the Hub ask: "no folder yet"): the team's home folder if it has one, else the first of its sessions that HAS a working directory (not just the first session), else ''.
import assert from 'node:assert/strict';
import { pickTeamFolder } from '../../coral-go/pkg/frontend/static/server_base.js';

const rows = [{ name: 'terminal', working_directory: '' }, { name: 'stale' }, null, { name: 'worker', working_directory: '/work/crew' }, { name: 'other', working_directory: '/work/other' }];
assert.equal(pickTeamFolder('', rows), '/work/crew', 'the first session has no path: the first one that has a path counts');
assert.equal(pickTeamFolder('/home/team', rows), '/home/team', 'a home folder comes first');
assert.equal(pickTeamFolder('  ', rows), '/work/crew', 'a blank home folder is none');
assert.equal(pickTeamFolder('', [{ name: 'a' }, { name: 'b', working_directory: '' }]), '', 'none anywhere: empty (the dialog asks for a folder)');
assert.equal(pickTeamFolder(undefined, undefined), '', 'nothing at all: empty');
console.log('team_folder_pick: ok');
