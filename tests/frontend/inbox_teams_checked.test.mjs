// The teams a saved Inbox choice is drawn from are read with every contributing source checked (#12783, UI Reviewer): a source that cannot be read is an error, not an empty or a shorter list, so Save never
// rewrites the choice from a partial answer. In the cloud there is no local read at all: the computers a hub manages are the sources, each one checked.
//   node inbox_teams_checked.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'cloud' });
const { state } = await importUi('state');
const { fetchProjectsChecked } = await importUi('board_fetch');
const answer = (status, body) => ({ ok: status < 400, status, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });
let calls = [], plan = {};
globalThis.fetch = window.fetch = async url => { const u = String(url); calls.push(u); const hit = Object.keys(plan).find(k => u.includes(k)); return hit ? plan[hit]() : answer(404, {}); };
state.hub = true;
state.servers = [{ id: 'srv2', name: 'two', status: 'online' }, { id: 'srv3', name: 'three', status: 'online' }, { id: 'srv4', name: 'four', status: 'offline' }];

// every online computer answers: all their teams, and nothing was read from this computer (a cloud page has no local boards) or from an offline one
plan = { '/srv2/': () => answer(200, [{ project: 'a' }]), '/srv3/': () => answer(200, [{ project: 'b' }, { project: 'c' }]) };
let list = await fetchProjectsChecked();
assert.equal(list.length, 3, 'the teams of both online computers');
assert.ok(!calls.some(u => u === '/api/board/projects'), 'the cloud page asks no local boards: ' + calls);
assert.ok(!calls.some(u => u.includes('srv4')), 'an offline computer is not a source');

// one of them refuses: the whole read is an error, not the other computer's teams alone
plan = { '/srv2/': () => answer(200, [{ project: 'a' }]), '/srv3/': () => answer(502, { error: 'offline' }) };
await assert.rejects(fetchProjectsChecked(), /another computer could not be read/);
// one answers with something that is not a list: an error as well
plan = { '/srv2/': () => answer(200, { error: 'x' }), '/srv3/': () => answer(200, []) };
await assert.rejects(fetchProjectsChecked(), /could not be read/);
// a computer that throws
plan = { '/srv2/': () => { throw new Error('network'); }, '/srv3/': () => answer(200, []) };
await assert.rejects(fetchProjectsChecked());
// a computer with no teams is a genuinely empty source, not a failure
plan = { '/srv2/': () => answer(200, []), '/srv3/': () => answer(200, []) };
assert.deepEqual(await fetchProjectsChecked(), []);
console.log('Inbox teams checked: every source is checked, a failure is an error, an empty list is not');
process.exit(0);
