// What a file's name and type say it is, for a tile (#19828). node file_kind.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const { fileKindOf, FILE_KINDS } = await import(pathToFileURL(path.join(dir, 'file_kind.js')).href);
const k = (n, t) => fileKindOf(n, t).kind;
assert.equal(k('inbox-list-design-mocks.html'), 'html');
assert.equal(k('design-19669.md'), 'markdown');
assert.equal(fileKindOf('a.md').glyph, 'M↓', 'markdown has no icon: a text glyph');
assert.equal(k('promo-cut-1.mp4'), 'video');
assert.equal(k('inbox-mobile-390.png'), 'image');
assert.equal(k('Main.GO'), 'code', 'the extension is read in lower case');
assert.equal(k('noext', 'video/webm'), 'video', 'no extension: the media type');
assert.equal(k('report.bin', 'application/pdf'), 'pdf');
assert.equal(k('weird.xyz'), 'file');
assert.equal(k('toString'), 'file', 'a name that is an Object property is not a kind');
assert.equal(k('constructor.constructor'), 'file');
assert.equal(k(undefined, undefined), 'file');
// every icon named is in the shipped subset (a new one would render as its own name)
const subset = new Set(fs.readFileSync(path.join(here, 'fixtures', 'material-icons.names.txt'), 'utf8').split('\n').filter(Boolean));
for (const [kind, v] of Object.entries(FILE_KINDS)) assert.ok(v.glyph || subset.has(v.icon), `${kind}: ${v.icon} is in the icon subset`);
console.log('ok file_kind');
