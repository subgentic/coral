// A single ~ is a character, not strikethrough (#18435): 'cd ~/a && ls ~/b' keeps both tildes and has no <del> in a chat or board message, a note, a viewed file and a Docs page; ~~gone~~ still strikes.
//   node markdown_tilde.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
// the real marked (the jsdom env's is a stub that returns its text)
const here = path.dirname(fileURLToPath(import.meta.url));
(0, eval)(fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/vendor/marked.min.js'), 'utf8'));
assert.equal(typeof globalThis.marked?.parse, 'function', 'the real marked is loaded');
if (typeof window !== 'undefined') window.marked = globalThis.marked;
globalThis.DOMPurify = { sanitize(html) { const t = document.createElement('template'); t.innerHTML = html; return t.content; }, addHook() {}, removeHook() {}, removeAllHooks() {}, setConfig() {}, isSupported: true };
const { renderMarkdown, renderMarkdownStrict } = await importUi('utils');
const { renderDocsMarkdown } = await importUi('docs_markdown');
const html = h => String(h);
const CMD = 'cd ~/coral-test-data3 && ls ~/Coral-rc2-mnt';
for (const [what, render] of [['chat', md => renderMarkdown(md, undefined, 'chat')], ['board', md => renderMarkdown(md, { breaks: true }, 'board')], ['a viewed file', renderMarkdownStrict], ['a Docs page', renderDocsMarkdown], ['the shared marked (notes, file preview)', md => globalThis.marked.parse(md)]]) {
    const out = html(render(CMD));
    assert.ok(!/<del/.test(out), `${what}: two ~/ paths are not struck through: ${out}`);
    assert.equal((out.match(/~/g) || []).length, 2, `${what}: both tildes stay: ${out}`);
    assert.ok(/<del>gone<\/del>/.test(html(render('a ~~gone~~ b'))), `${what}: a double tilde still strikes`);
    assert.ok(!/<del/.test(html(render('~one~ and ~/x'))), `${what}: ~one~ is text`);
}
console.log('markdown_tilde ok');
