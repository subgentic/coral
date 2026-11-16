// #18768: the pages a question card may open are one fixed list: the dashboard's (ask_open_page.js) names the same pages, with the same words, as the server's (internal/askpage).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const go = fs.readFileSync(path.join(here, '../../coral-go/internal/askpage/askpage.go'), 'utf8');
const fromGo = [...go.matchAll(/\{"([a-z-]+)", "([^"]+)"\}/g)].map(m => [m[1], m[2]]);
const js = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/ask_open_page.js'), 'utf8');
const fromJs = [...js.matchAll(/^\s{4}([a-z-]+): \{ label: '([^']+)'/gm)].map(m => [m[1], m[2]]);
assert.ok(fromGo.length >= 2, 'the Go list was read');
assert.deepEqual(fromJs, fromGo, 'the dashboard and the server name the same pages with the same button words');
console.log('PASS ask pages: ' + fromGo.map(p => p[0]).join(', '));
