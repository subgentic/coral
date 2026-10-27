// A table's note and its Retry (#8933, Codex Test's review): the note that a computer did not answer, with its Retry button, is under the table whether the table has rows or is empty (the folder that is
// empty because a computer did not answer is the one that needs them); a click on Retry runs that table's own retry, once; a table with no retry has no button, and one with no note has neither.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
try {
    const G = await importUi('sidebar_groups');
    const note = 'Box Two did not answer, so its goals are not shown.';
    const html = t => { const host = document.createElement('div'); host.innerHTML = G.tableMarkup({ title: 'Goals', rows: [], ...t }); return host; };
    const retryOf = host => host.querySelector('.group-table-retry');

    // populated
    let h = html({ rows: [{ id: 1 }], note, retry() {} });
    assert.equal(h.querySelector('.group-table-note').firstChild.textContent.trim(), note, 'populated: the note');
    assert.equal(retryOf(h).textContent, 'Retry', 'populated: and its Retry');
    assert.equal(retryOf(h).getAttribute('aria-label'), 'Retry reading goals', 'named for what it reads');
    // empty: the case Codex Test reproduced
    h = html({ rows: [], empty: { line: 'No open goals.' }, note, retry() {} });
    assert.equal(h.querySelector('.empty-line').textContent, 'No open goals.', 'empty: its one line stays');
    assert.equal(h.querySelector('.group-table-note').firstChild.textContent.trim(), note, 'empty: the note is there too');
    assert.ok(retryOf(h), 'empty: and its Retry');
    assert.ok(h.querySelector('.empty-pane').compareDocumentPosition(retryOf(h)) & 4, 'the note follows the empty line');
    // no retry, no note
    h = html({ rows: [], empty: { line: 'x' }, note });
    assert.equal(retryOf(h), null, 'a note with no retry has no button');
    assert.ok(h.querySelector('.group-table-note'), 'but keeps its note');
    h = html({ rows: [{ id: 1 }], retry() {} });
    assert.equal(h.querySelector('.group-table-note'), null, 'no note: no note');
    assert.equal(retryOf(h), null, 'and no Retry');

    // the action: the table on screen is found by its index and its own retry runs, once per click
    const calls = [];
    G.registerGroupSource('retry-test', { keys: () => ['empty', 'full'], redraw() {}, isEmpty: () => false, showList() {}, empty() {},
        table: key => ({ title: key === 'empty' ? 'Goals' : 'Tasks', rows: key === 'full' ? [{ id: 1 }] : [], empty: { line: 'None.' }, note, retry: () => calls.push(key), signature: key,
            node: () => document.createElement('span') }) });
    for (const key of ['empty', 'full']) {
        assert.ok(G.openGroupTable('retry-test', key), `${key}: the table opens`);
        const button = document.querySelector('#group-table-view .group-table-retry');
        assert.ok(button, `${key}: Retry is on screen`);
        button.click();
        assert.deepEqual(calls, key === 'empty' ? ['empty'] : ['empty', 'full'], `${key}: a click runs that table's retry, once`);
    }
    console.log('group_table_retry: ok');
} finally { dom.close && dom.close(); }
