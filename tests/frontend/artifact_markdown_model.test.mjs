import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { installDom, STATIC } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
dom.window.eval(fs.readFileSync(STATIC + 'vendor/marked.min.js', 'utf8')); globalThis.marked = dom.window.marked;
dom.window.eval(fs.readFileSync(STATIC + 'vendor/purify.min.js', 'utf8')); globalThis.DOMPurify = dom.window.DOMPurify;
import * as modelApi from '../../coral-go/pkg/frontend/static/artifact_markdown_model.js';
import { analyze, mapRenderedBlock, editRun } from '../../coral-go/pkg/frontend/static/artifact_markdown_model.js';
import { renderMarkdownStrict } from '../../coral-go/pkg/frontend/static/markdown.js';
function bytePatch(before, after) {
    const a = new TextEncoder().encode(before), b = new TextEncoder().encode(after); let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    return { offset: prefix, removedBytes: a.length - prefix - suffix, insertedBytes: b.length - prefix - suffix, unchangedPrefixBytes: prefix, unchangedSuffixBytes: suffix };
}

function mapped(source) {
    const model = analyze(source, marked);
    return model.blocks.flatMap(block => { const host = document.createElement('div'); host.innerHTML = renderMarkdownStrict(block.raw + (model.references ? '\n\n' + model.references : '')); const map = mapRenderedBlock(block, host); return map.exact ? map.entries.map(e => e.run) : []; });
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

test('a repeated paragraph in an omitted reference definition never redirects an edit into the URL', () => {
    for (const source of ['[x]: Words.\nWords.\n', '[x]:\nWords.\n\nWords.\n', '\ufeff[x]: Words.\r\nWords.\r\n']) {
        const run = mapped(source).find(r => r.text === 'Words.'); assert.ok(run);
        const paragraphStart = source.lastIndexOf('Words.');
        assert.equal(run.start, paragraphStart, 'the editable text belongs to the visible paragraph');
        assert.equal(editRun(source, run, 'Revised.').source, source.slice(0, paragraphStart) + 'Revised.' + source.slice(paragraphStart + 'Words.'.length));
    }
});


test('reference labels retain their definition URL and original source syntax', () => {
    const source = '[x]: https://example.com/original\n\nUse [the label][x].\n';
    const run = mapped(source).find(r => r.text === 'the label'); assert.ok(run);
    assert.equal(editRun(source, run, 'clear label').source, '[x]: https://example.com/original\n\nUse [clear label][x].\n');
});


test('block reapply preserves every newest byte outside the Operator-edited block', () => {
    assert.equal(typeof modelApi.reapplyEdits,'function');
    const base='\ufeff# Report\r\n\r\nOld sentence.\r\n\r\nOld second block.\r\n', draft=base.replace('Old sentence.','My sentence.'), theirs=base.replace('Old second block.','Agent second block.');
    const result=modelApi.reapplyEdits(base,draft,theirs,marked);assert.equal(result.ok,true);assert.equal(result.source,theirs.replace('Old sentence.','My sentence.'));
    const inserted=theirs+'\r\nA new agent paragraph.\r\n';assert.equal(modelApi.reapplyEdits(base,draft,inserted,marked).source,inserted.replace('Old sentence.','My sentence.'));
});
test('block reapply refuses changed or ambiguous edited blocks instead of dropping agent work', () => {
    assert.equal(typeof modelApi.reapplyEdits,'function');
    const base='Old sentence.\n\nOld second block.\n',draft=base.replace('Old sentence.','My sentence.');
    assert.equal(modelApi.reapplyEdits(base,draft,base.replace('Old sentence.','Agent sentence.'),marked).ok,false);
    const duplicate='Same words.\n\nSame words.\n\n';assert.equal(modelApi.reapplyEdits(duplicate,duplicate.replace('Same words.','My words.'),duplicate,marked).ok,false);
});
