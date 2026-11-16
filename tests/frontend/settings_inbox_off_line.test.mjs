// Each Inbox kind switch says what turning it off does and how to bring it back (#17242, walk 57): 'Daily digest' saved with no line at all.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../../coral-go/pkg/frontend/static');
const src = (await import('node:fs')).readFileSync(path.join(dir, 'settings_fields.js'), 'utf8');
const kinds = [...src.matchAll(/key: '(inbox_kind_\w+)', type: 'toggle'[^\n]*?help: '((?:[^'\\]|\\.)*)'/g)];
assert.equal(kinds.length, 5, 'the five Inbox kinds are found: ' + kinds.map(k => k[1]));
const bad = kinds.filter(k => !/ Off: [^.]+; turn it on again here\.$/.test(k[2])).map(k => k[1]);
assert.deepEqual(bad, [], 'each kind says what Off does and where to turn it on again');
console.log('PASS settings_inbox_off_line: each of the five Inbox kinds says what Off does and how to turn it on again');
