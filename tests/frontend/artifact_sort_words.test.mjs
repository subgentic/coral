// #8945: a paged artifact list asks the server for the order: every header in both directions maps to the server's sort word (name, type, tags A to Z and _desc; size largest first and size_asc; updated newest and
// oldest), and a click on a paged table's header sends that word to the page. jsdom; the table is the shared artifact table.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
try {
    const { serverArtifactSort, artifactTable } = await importUi('artifact_table');
    const word = (key, dir) => serverArtifactSort({ key, dir });
    assert.deepEqual(['name', 'type', 'tags'].flatMap(k => [word(k, 'asc'), word(k, 'desc')]), ['name', 'name_desc', 'type', 'type_desc', 'tags', 'tags_desc']);
    assert.equal(word('size', 'desc'), 'size', 'size: largest first is the server\'s size');
    assert.equal(word('size', 'asc'), 'size_asc');
    assert.equal(word('updated', 'desc'), 'newest'); assert.equal(word('updated', 'asc'), 'oldest');
    const sent = [];
    const rows = [{ id: '1'.repeat(64), name: 'a.md', media_type: 'text/markdown', size: 5, created_at: '2026-10-01T00:00:00Z', tags: ['x'] }, { id: '2'.repeat(64), name: 'b.png', media_type: 'image/png', size: 9, created_at: '2026-10-02T00:00:00Z' }];
    const table = artifactTable({ label: 'Artifacts', rows, paged: true, onPageSort: w => sent.push(w) });
    document.body.append(table.el);
    const head = key => table.el.querySelector(`th[data-key="${key}"] .dt-sort, th[data-key="${key}"] button`);
    assert.ok(['type', 'tags'].every(k => head(k)), 'Type and Tags are sortable in a paged list now');
    for (const key of ['name', 'type', 'tags', 'size']) head(key).click();
    assert.deepEqual(sent, ['name', 'type', 'tags', 'size'], 'the first click of each header: A to Z, and the largest size first');
    for (const key of ['size', 'type', 'type', 'name', 'name']) head(key).click();
    assert.deepEqual(sent.slice(4), ['size_asc', 'type', 'type_desc', 'name', 'name_desc'], 'a second click on the same header reverses it (size: smallest first)');
    console.log('artifact_sort_words: ok');
} finally { dom.close && dom.close(); }
