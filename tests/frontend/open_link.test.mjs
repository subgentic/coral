// open_link.js (#15253): the address's ?open=<file or artifact>[&thread=<id>]. A repository path or one coral:// artifact opens; a thread counts only beside an artifact and only as digits; every other
// shape (another scheme, a control or formatting character, padding, a long line, a second kind of artifact) is no link at all.
import assert from 'node:assert/strict';
import { parseOpen } from '../../coral-go/pkg/frontend/static/open_link.js';

const hex = 'ab'.repeat(32);
const uri = 'coral://artifacts/' + hex;
const q = o => '?' + new URLSearchParams(o).toString();

assert.deepEqual(parseOpen(q({ open: 'src/main.go' })), { path: 'src/main.go', thread: null });
assert.deepEqual(parseOpen(q({ open: 'docs/a b.md' })), { path: 'docs/a b.md', thread: null }, 'a space inside is part of the name');
assert.deepEqual(parseOpen(q({ open: uri })), { path: uri, thread: null });
assert.deepEqual(parseOpen(q({ open: uri, thread: '12' })), { path: uri, thread: 12 });
assert.deepEqual(parseOpen(q({ open: 'src/main.go', thread: '12' })), { path: 'src/main.go', thread: null }, 'a file has no thread');
assert.deepEqual(parseOpen(q({ open: uri, thread: 'abc' })), { path: uri, thread: null });
for (const t of ['0', '012', '-1', '1.5', '1e3', ' 1', '1'.repeat(17), '']) assert.equal(parseOpen(q({ open: uri, thread: t })).thread, null, 'not a thread: ' + JSON.stringify(t));

const bad = [
    '', '?x=1', q({ open: '' }), q({ open: ' x ' }), q({ open: 'a\nb' }), q({ open: 'a\u0000b' }), q({ open: 'a\u202eb' }), q({ open: 'a\u200bb' }), q({ open: 'x'.repeat(1025) }),
    q({ open: 'javascript:alert(1)' }), q({ open: 'data:text/html,x' }), q({ open: 'https://example.com/x' }), q({ open: 'file:///etc/passwd' }),
    q({ open: 'coral://artifacts/zz' }), q({ open: 'coral://artifacts/' + hex + '0' }), q({ open: 'coral://other/' + hex }), q({ open: 'coral://artifacts/' + hex + '/x' }),
];
for (const s of bad) assert.equal(parseOpen(s), null, 'not a link: ' + JSON.stringify(s));
assert.equal(parseOpen(q({ open: 'x'.repeat(1024) })).path.length, 1024, 'the longest allowed');
assert.equal(parseOpen(undefined), null);
console.log('open_link: ok');
