// chat_filters.js: the Inbox chat folders' filters: what is kept, the fields each folder has, the history parameters they become, the chips (#8603).
import assert from 'node:assert/strict';

globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const CF = await import('../../coral-go/pkg/frontend/static/chat_filters.js');

assert.deepEqual(CF.fieldsFor('chats'), ['cli', 'agent', 'tagId', 'folder', 'dates']);
assert.deepEqual(CF.fieldsFor('chats-starred'), ['cli', 'agent', 'tagId', 'folder', 'dates']);
assert.deepEqual(CF.fieldsFor('chats-archived'), ['cli', 'agent', 'tagId', 'folder', 'dates']);
assert.deepEqual(CF.fieldsFor('chats-cli-claude'), ['agent', 'tagId', 'folder', 'dates'], 'a CLI folder has no CLI field');
assert.deepEqual(CF.fieldsFor('chats-tag-7'), ['cli', 'agent', 'folder', 'dates'], 'a tag folder has no tag field');
assert.deepEqual(CF.fieldsFor('chats-group'), ['dates'], 'a board history has dates only');

const all = { ...CF.EMPTY, cli: 'codex', agent: 'Frontend Dev', tagId: '7', from: '2026-10-01', to: '2026-10-20' };
assert.deepEqual(CF.toParams('chats', all), { source_types: 'codex', agent_name: 'Frontend Dev', tag_ids: '7', date_from: '2026-10-01', date_to: '2026-10-20' });
assert.deepEqual(CF.toParams('chats', CF.EMPTY), {}, 'nothing set sends nothing');
assert.deepEqual(CF.toParams('chats-cli-claude', all), { agent_name: 'Frontend Dev', tag_ids: '7', date_from: '2026-10-01', date_to: '2026-10-20' }, 'the folder\'s own CLI is not asked again');
assert.deepEqual(CF.toParams('chats-tag-7', all), { source_types: 'codex', agent_name: 'Frontend Dev', date_from: '2026-10-01', date_to: '2026-10-20' }, 'nor its own tag');
assert.deepEqual(CF.toParams('chats-group', all), { date_from: '2026-10-01', date_to: '2026-10-20' }, 'a board history takes the dates and nothing else');
assert.deepEqual(CF.toParams('chats', { ...CF.EMPTY, q: 'words' }), {}, 'the search is the caller\'s own, not a parameter here');

assert.deepEqual(CF.clean({ cli: 'vim', agent: 5, tagId: 'x', from: 'soon', to: '2026-13-45' }), CF.EMPTY, 'what is not valid is dropped');
assert.equal(CF.clean({ tagId: '12' }).tagId, '12'); assert.equal(CF.clean({ tagId: '0' }).tagId, '', 'a tag id is a positive number');
assert.deepEqual(CF.clean({ from: '2026-10-20', to: '2026-10-01' }), { ...CF.EMPTY, from: '2026-10-01', to: '2026-10-20' }, 'a reversed range is put the right way round');

CF.setTagNames(new Map([['7', 'Release']]));
assert.deepEqual(CF.chips({ ...CF.EMPTY, q: 'x', cli: 'agy', agent: 'QA', tagId: '7', from: '2026-10-01', to: '2026-10-20' }).map(c => c.label), ['CLI: Antigravity', 'Agent: QA', 'Tag: Release', 'Dates: 2026-10-01 to 2026-10-20']);
assert.deepEqual(CF.chips({ ...CF.EMPTY, q: 'x' }), [], 'the search box shows the words: no chip of them (#10484)');
assert.deepEqual(CF.chips({ ...CF.EMPTY, from: '2026-10-01' }).map(c => c.label), ['From 2026-10-01']);
assert.deepEqual(CF.chips({ ...CF.EMPTY, to: '2026-10-20' }).map(c => c.label), ['Until 2026-10-20']);
assert.deepEqual(CF.chips({ ...CF.EMPTY, tagId: '99' }).map(c => c.label), ['Tag: Tag'], 'a tag it does not know reads Tag');
assert.deepEqual(CF.without({ ...CF.EMPTY, from: '2026-10-01', to: '2026-10-20', cli: 'pi' }, 'dates'), { ...CF.EMPTY, cli: 'pi' }, 'the dates are one chip');
assert.equal(CF.isFiltered({ ...CF.EMPTY, tagId: '7' }), true); assert.equal(CF.isFiltered(CF.EMPTY), false);

// #10390: the Folder filter sends the folder a chat ran in, as chosen; a value that is no absolute path is dropped; the chip and the column say the last part
assert.deepEqual(CF.toParams('chats', { ...CF.EMPTY, folder: '/srv/app' }), { working_dir: '/srv/app' });
assert.deepEqual(CF.toParams('chats', { ...CF.EMPTY, folder: '~/proj' }), { working_dir: '~/proj' }, 'the ~ form a Hub viewer is shown is kept (the machine expands it)');
assert.deepEqual(CF.toParams('chats-group', { ...CF.EMPTY, folder: '/srv/app' }), {}, 'a board history has no folder field');
assert.equal(CF.clean({ folder: 'app' }).folder, '', 'a folder is an absolute path'); assert.equal(CF.clean({ folder: 'C:\\work\\app' }).folder, 'C:\\work\\app');
assert.deepEqual(CF.chips({ ...CF.EMPTY, folder: '/srv/app' }).map(c => c.label), ['Folder: app']);
assert.equal(CF.folderName('/srv/app/'), 'app'); assert.equal(CF.folderName('C:\\work\\app'), 'app'); assert.equal(CF.folderName('/'), '/');

CF.saveFilters('chats-starred', { ...CF.EMPTY, cli: 'codex', q: 'not kept' });
assert.deepEqual(CF.loadFilters('chats-starred'), { ...CF.EMPTY, cli: 'codex' }, 'kept for the folder, without the search words');
assert.deepEqual(CF.loadFilters('chats'), CF.EMPTY, 'another folder keeps its own');
CF.saveFilters('chats-starred', CF.EMPTY);
assert.deepEqual(CF.loadFilters('chats-starred'), CF.EMPTY, 'nothing chosen keeps nothing');
console.log('chat_filters: ok');
