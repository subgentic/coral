// #13687: an empty picker says which computer was asked, how many agents it listed and how many cannot be named.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { emptyWords, pickableAgents, buildSendBlock } = await importUi('artifact_comment_send');
assert.equal(emptyWords('', 0, 0), 'No agent on this board can be asked: this computer lists no agent on it.');
assert.equal(emptyWords('build-box', 3, 0), 'No agent on this board can be asked: the computer build-box lists 3 agents, 3 without a role on the team or a terminal.');
assert.equal(emptyWords('m1', 1, 0), 'No agent on this board can be asked: the computer m1 lists 1 agent, 1 without a role on the team or a terminal.');
const listed = [{ name: 'solo', role: '' }, { name: 'term', role: 'Dev', agent_type: 'terminal' }];
assert.equal(pickableAgents(listed).length, 0, 'no role and a terminal cannot be named');
const block = buildSendBlock({ id: 1, board: 'team-a', agents: [], empty: emptyWords('m1', listed.length, 0), picked: new Set(), asked: new Map(), count: 1, results: null, busy: false, error: '', onToggle() {}, onCancel() {}, onSend() {} });
assert.match(block.textContent, /the computer m1 lists 2 agents, 2 without a role/);
const plain = buildSendBlock({ id: 1, board: 'team-a', agents: [], picked: new Set(), asked: new Map(), count: 1, results: null, busy: false, error: '', onToggle() {}, onCancel() {}, onSend() {} });
assert.match(plain.textContent, /No agent on this board can be asked\./);
console.log('artifact_comment_send_empty: an empty picker says why');
