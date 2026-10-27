// isBoardAnswer (#8798): the answer of a team's board routes names the board by its id; a team opened by NAME asked with its label, so the page accepts the id of the board that label names, and nothing else.
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', host: 'x' };
const S = await import('../../coral-go/pkg/frontend/static/server_base.js');

assert.equal(S.isBoardAnswer('b-abc1234567', 'b-abc1234567'), true, 'asked by id, answered with the id');
assert.equal(S.isBoardAnswer('Name Team', 'b-abc1234567'), false, 'a label the page does not know is not that board (nothing to compare)');
S.noteBoardLabels([{ board_id: 'b-abc1234567', board_label: 'Name Team' }], 'board_id', 'local');
assert.equal(S.isBoardAnswer('Name Team', 'b-abc1234567'), true, 'asked by the label, answered with the id of the board it names');
assert.equal(S.isBoardAnswer('name team', 'b-abc1234567'), true, 'in any case');
assert.equal(S.isBoardAnswer('Name Team', 'b-other00000'), false, 'another board is not it');
assert.equal(S.isBoardAnswer('Name Team', ''), false);
S.noteBoardLabels([{ board_id: 'b-remote0000', board_label: 'Name Team' }], 'board_id', 'box-2');
assert.equal(S.isBoardAnswer('@box-2/Name Team', 'b-remote0000'), true, 'on another computer, by its label there');
assert.equal(S.isBoardAnswer('@box-2/Name Team', 'b-abc1234567'), false, 'not the same-named board of this computer');
console.log('board_answer_unit: ok');
