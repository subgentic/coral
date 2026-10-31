// #11561 (the operator: a ghost 'Active' label floating over the State header after scrolling up in the Inbox Goals list): a state chip already shows its word, so it carries no `title`. The title was a native
// browser tooltip saying the same word again; when the table scrolled under a resting pointer the browser left it up, where the chip had been. A real tooltip is only for words the screen cuts (a truncated name).
// Failing-first: it fails on data_table.js before #11561 (chip() set c.title = word).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static/data_table.js'), 'utf8');
const at = src.indexOf('export function chip('), body = src.slice(at, src.indexOf('\n}', at));
assert.ok(at > 0, 'data_table.js has chip()');
assert.ok(!/^\s*c\.title\s*=/m.test(body) && /pointerenter/.test(body), `chip() sets no title when it is built; only on pointerenter, while its word is hidden (a native tooltip that repeats the visible word is left behind on scroll):\n${body}`);
console.log('state_chip_no_tooltip: ok');
