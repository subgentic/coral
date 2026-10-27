// isBoardAnswer (#8798): the answer of a team's board routes names the board by its id; a team opened by NAME asked with its label, so the page accepts the id of the board that label names, and nothing else.
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', host: 'x' };
const S = await import('../../coral-go/pkg/frontend/static/server_base.js');

assert.equal(S.isBoardAnswer('b-abc1234567', 'b-abc1234567'), true, 'asked by id, answered with the id');
assert.equal(S.isBoardAnswer('Name Team', 'b-abc1234567'), false, 'a label the page does not know is not that board (nothing to compare)');
assert.equal(S.isBoardAnswerPending('Name Team', 'b-abc1234567'), true, 'unknown name waits for labels');
assert.equal(S.isBoardAnswerPending('b-known00000', 'b-abc1234567'), false, 'id mismatches never wait for labels');
assert.equal(S.isBoardAnswerPending('Name Team', ''), false, 'an empty answer never waits');
S.noteBoardLabels([{ board_id: 'b-abc1234567', board_label: 'Name Team' }], 'board_id', 'local');
assert.equal(S.isBoardAnswer('Name Team', 'b-abc1234567'), true, 'asked by the label, answered with the id of the board it names');
assert.equal(S.isBoardAnswer('name team', 'b-abc1234567'), true, 'in any case');
assert.equal(S.isBoardAnswer('Name Team', 'b-other00000'), false, 'another board is not it');
assert.equal(S.isBoardAnswer('Name Team', ''), false);
S.noteBoardLabels([{ board_id: 'b-remote0000', board_label: 'Name Team' }], 'board_id', 'box-2');
assert.equal(S.isBoardAnswer('@box-2/Name Team', 'b-remote0000'), true, 'on another computer, by its label there');
assert.equal(S.isBoardAnswer('@box-2/Name Team', 'b-abc1234567'), false, 'not the same-named board of this computer');
assert.equal(S.isBoardAnswerPending('Name Team', 'b-other00000'), false, 'known requested name still refuses another board');
assert.equal(S.isBoardAnswerPending('Unknown Team', 'b-abc1234567'), false, 'known answer label is a decidable mismatch');
assert.equal(S.isBoardAnswerPending('@box-3/Name Team', 'b-abc1234567'), true, 'another server labels do not decide this server answer');
assert.equal(S.isBoardAnswerPending('@box-2/Name Team', 'b-other00000'), false, 'known remote name still refuses another board');
console.log('board_answer_unit: ok');
