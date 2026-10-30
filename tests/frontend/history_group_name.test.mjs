// #11070: Board history names a board the way the sidebar does. Team-launched boards (b-wvvnbdjqjb) came as their id: the row's title is empty and the board-label registry (noteBoardLabels,
// fed by board_label) was never asked. The label wins, then the row's own title, then the key.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { noteBoardLabels } = await importUi('server_base');
const { groupChatName, groupChatKeyName } = await importUi('history_list');
noteBoardLabels([{ board_project: 'b-wvvnbdjqjb', board_label: 'Release crew' }, { board_project: 'coral-hub', board_label: 'coral-hub' }]);

const row = (id, title) => ({ type: 'group', session_id: 'board:' + id, title });
assert.equal(groupChatName(row('b-wvvnbdjqjb', '')), 'Release crew', 'a board with no title is named by its label, not its id');
assert.equal(groupChatName(row('b-wvvnbdjqjb', 'b-wvvnbdjqjb')), 'Release crew', 'a title that is the id is the same board: its label');
assert.equal(groupChatName(row('coral-hub', 'coral-hub')), 'coral-hub', 'a board whose label is its name is shown as it was');
assert.equal(groupChatName(row('coral-go-team', 'coral-go-team')), 'coral-go-team', 'a board with no label is shown by its title');
assert.equal(groupChatName(row('b-4tt7u67wul', '')), 'b-4tt7u67wul', 'the id is the fallback only when nothing else is known');
// a board the page has not met (an old, archived one): the row's own label, then the id
assert.equal(groupChatName({ ...row('b-unmet00001', 'b-unmet00001'), board_label: 'Old crew' }), 'Old crew', 'the row\'s board_label names a board the registry does not know');
assert.equal(groupChatName({ ...row('b-wvvnbdjqjb', ''), board_label: 'Stale row label' }), 'Release crew', 'the registry (the sidebar\'s name) wins over the row');
assert.equal(groupChatKeyName(row('b-wvvnbdjqjb', '')), 'b-wvvnbdjqjb', 'the key a row opens stays the board id, never the label');
console.log('PASS board history names: label, then title, then key');
