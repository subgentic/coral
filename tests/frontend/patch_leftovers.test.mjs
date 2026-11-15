// #17743: fail on tracked patch leftovers (*.orig, *.rej, *.bak) anywhere in the tree.
// A stray rn.orig at the repo root held up #17610; this catches it before review.
import assert from 'node:assert/strict';
import { execFileSync } from './helpers/child_process.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = execFileSync('git', ['ls-files', '--', '*.orig', '*.rej', '*.bak'], { cwd: root, encoding: 'utf8' });
const files = out.split(/\r?\n/).filter(Boolean);
assert.deepEqual(files, [], 'tracked patch leftovers (remove them with git rm): ' + files.join(', '));
console.log('patch_leftovers: ok');
