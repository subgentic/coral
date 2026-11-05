import assert from 'node:assert/strict';
import test from 'node:test';
import './measure.mjs'; // installs the actual vendored marked + DOMPurify and DOM
import { analyze, mapRenderedBlock, editRun, bytePatch } from './model.mjs';
import { renderMarkdownStrict } from '../../../coral-go/pkg/frontend/static/markdown.js';
function mapped(source) {
    return analyze(source, marked).blocks.flatMap(block => { const host = document.createElement('div'); host.innerHTML = renderMarkdownStrict(block.raw); const map = mapRenderedBlock(block, host); return map.exact ? map.entries.map(e => e.run) : []; });
}
test('BOM, CRLF, mixed endings, marks, URLs and every untouched byte survive a word edit', () => {
    const source = '\ufeff# Heading\r\n\r\nA **careful word** and [stable link](https://example.com/x?q=1).\r\n\r\n- Keep this item\r\n\n```md\nUntouched **raw**\n```\r\n';
    const run = mapped(source).find(r => r.text === 'careful word'); assert.ok(run);
    const { source: next, patch } = editRun(source, run, 'careful sentence');
    assert.equal(next, source.replace('careful word', 'careful sentence'));
    assert.equal(next.charCodeAt(0), 0xfeff);
    assert.deepEqual(bytePatch(source, next), { offset: new TextEncoder().encode(source.slice(0, patch.start)).length, removedBytes: 4, insertedBytes: 8, unchangedPrefixBytes: new TextEncoder().encode(source.slice(0, patch.start)).length, unchangedSuffixBytes: new TextEncoder().encode(source.slice(patch.end)).length });
});
test('words on a wrapped CRLF paragraph map to original source offsets', () => {
    const source = 'First line\r\nsecond sentence.\r\n'; const run = mapped(source).find(r => r.text.includes('second')); assert.ok(run);
    assert.equal(editRun(source, run, run.text.replace('second', 'revised')).source, 'First line\r\nrevised sentence.\r\n');
});
test('link labels and code words can change without rewriting URLs or delimiters', () => {
    const source = 'A [stable label](https://example.com/path) and `old code`.\n'; const runs = mapped(source);
    const label = runs.find(r => r.text === 'stable label'), code = runs.find(r => r.text === 'old code'); assert.ok(label && code);
    assert.equal(editRun(source, label, 'clear label').source, 'A [clear label](https://example.com/path) and `old code`.\n');
    assert.equal(editRun(source, code, 'new code').source, 'A [stable label](https://example.com/path) and `new code`.\n');
    assert.throws(() => editRun(source, code, 'new ` code'), /delimiter/);
});
test('inserted Markdown characters are literal text and no old punctuation is reserialized', () => {
    const source = 'A plain sentence, unchanged punctuation.\n', run = mapped(source)[0];
    const next = editRun(source, run, 'A <b>plain</b> sentence, unchanged punctuation.').source;
    const host = document.createElement('div'); host.innerHTML = renderMarkdownStrict(next);
    assert.equal(host.querySelector('b'), null); assert.equal(host.querySelector('p').textContent, 'A <b>plain</b> sentence, unchanged punctuation.');
    assert.ok(next.endsWith(' sentence, unchanged punctuation.\n'));
});
test('readonly categories, ambiguous escapes and hidden characters never become editable', () => {
    const source = '---\ntitle: Keep\n---\n\n| A | B |\n| - | - |\n| x | y |\n\n```js\nconst x = 1;\n```\n\n<div>raw</div>\n\nHidden\u202e text\n';
    const model = analyze(source, marked); for (const block of model.blocks) if (['frontmatter','table','code','html'].includes(block.type) || block.raw.includes('\u202e')) assert.equal(block.runs.length, 0);
    assert.equal(mapped('A &amp; B \\*escaped\\* word.\n').length, 0);
    const run = mapped('Keep these words.\n')[0]; assert.throws(() => editRun('Keep these words.\n', run, 'Keep\nthese words.'), /line breaks/);
    assert.throws(() => editRun('Keep these words.\n', run, 'Keep\u202ethese words.'), /Hidden/);
});
test('emoji edits never split UTF-16 surrogates and byte offsets remain UTF-8 offsets', () => {
    const source = 'A 🍊 note.\n', run = mapped(source)[0]; const next = editRun(source, run, 'A 🍋 note.').source;
    assert.equal(next, 'A 🍋 note.\n'); assert.equal(Buffer.from(next).toString('utf8'), next);
});
