// The Link team dialog calls only the Hub's listed routes (#9888, coral-hub Security's condition 5; their own table test greps the same way): every path the dialog's file names is one of the five relay
// routes, the one local read of local mode, and the account flag file reads only /api/account. Text only: no innerHTML or inline handlers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const st = path.resolve(here, '../../coral-go/pkg/frontend/static');
const ALLOWED = new Set(['/api/relay/links', '/api/relay/links/{}', '/api/servers', '/api/remote/{}/api/board/projects', '/api/board/{}/cross-team-state']);
const src = fs.readFileSync(path.join(st, 'team_link_dialog.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'); // the header comment lists the routes in words; only code counts
const found = new Set();
for (const m of code.replace(/\$\{[^}]*\}/g, '{}').matchAll(/\/api\/[A-Za-z0-9_\-{}\/]*/g)) found.add(m[0].replace(/\/$/, ''));
assert.deepEqual([...found].filter(p => !ALLOWED.has(p)), [], 'a path the dialog may not call');
for (const p of ALLOWED) assert.ok(found.has(p), 'the dialog should call ' + p);
assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|\.on[a-z]+\s*=(?!=)/.test(code), 'text only, no inline handlers');
const flag = fs.readFileSync(path.join(st, 'team_link_flag.js'), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
assert.deepEqual([...flag.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map(m => m[1]), ['/api/account']);
console.log('team_link_dialog_calls: ok');
