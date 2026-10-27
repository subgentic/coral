// The heading outline of rendered Markdown (#9522): a message, a note or a viewed file that says "# Title" is drawn as the prose h1 but does not take over the page's own outline: its aria-level starts at 4 (h1 -> 4,
// h2 -> 5, h3 to h6 -> 6, the Hub renderer's rule for its md-h), a viewed file at 3 (under its dialog's h2), and a Docs page, which owns its h1, keeps its levels. The shared Hub renderer (renderSafe) already gives role=heading aria-level 4 to 6.
//   node markdown_headings.test.mjs
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
const { renderMarkdown, renderMarkdownStrict, renderDocsMarkdown } = await importUi('utils');
const MD = '# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six\n';
const levels = html => { const box = document.createElement('div'); box.innerHTML = html; return [...box.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => `${h.nodeName.toLowerCase()}:${h.getAttribute('aria-level')}`); };

const want = ['h1:4', 'h2:5', 'h3:6', 'h4:6', 'h6:6'];
assert.deepEqual(levels(renderMarkdown(MD, undefined, 'chat')), want, 'a chat message');
assert.deepEqual(levels(renderMarkdown(MD, { breaks: true }, 'board')), want, 'a board message, a note, a plan');
// the cache key has the base: one text through two hosts is two results (#9522 follow-up)
const same = '# Cached heading';
assert.deepEqual(levels(renderMarkdown(same, undefined, 'chat')), ['h1:4']);
assert.deepEqual(levels(renderMarkdown(same, undefined, 'chat', 2)), ['h1:3'], 'the same text with another base is its own entry, not the cached chat one');
assert.deepEqual(levels(renderMarkdown(same, undefined, 'chat')), ['h1:4'], 'and the first entry is unchanged');
assert.deepEqual(levels(renderMarkdownStrict(MD)), ['h1:3', 'h2:4', 'h3:5', 'h4:6', 'h6:6'], 'a viewed Markdown file sits under its dialog\'s h2: its h1 is level 3');
assert.deepEqual(levels(renderDocsMarkdown(MD)), ['h1:null', 'h2:null', 'h3:null', 'h4:null', 'h6:null'], 'a Docs page owns its h1');

// the Hub renderer's own headings are never above level 4 (vendor/safe-markdown.js)
const hub = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/vendor/safe-markdown.js'), 'utf8');
assert.ok(/setAttribute\('aria-level', String\(Math\.min\(6, 3 \+ m\[1\]\.length\)\)\)/.test(hub), 'the shared renderer gives its headings aria-level 3 + n, at most 6');
console.log('markdown_headings: ok (chat, board, viewer demoted to 4 to 6, Docs keeps its levels, the Hub renderer is 4 to 6)');
