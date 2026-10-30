// The Hub's account menu entries (#11106): `nav` names KEYS; Coral draws them from its own table, in the Hub's order, ignoring a key it does not know, a repeat and anything that is not a key; the label and the path are never the response's.
import assert from 'node:assert/strict';
import { accountNavEntries, ACCOUNT_NAV } from '../../coral-go/pkg/frontend/static/account_info.js';

assert.deepEqual(accountNavEntries([{ key: 'goals' }, { key: 'nope' }, { key: 'usage' }]), [['Goals', '/goals'], ['Usage', '/usage']], 'Goals then Usage, nothing for an unknown key');
assert.equal(accountNavEntries(undefined), null, 'no nav: null (today\'s links stay)');
assert.equal(accountNavEntries('goals'), null, 'nav that is not a list: null');
assert.deepEqual(accountNavEntries([]), [], 'an empty list: no entries');
assert.deepEqual(accountNavEntries([{ key: 'saved' }, { key: 'saved' }, { key: 'account' }]), [['Saved for later', '/saved'], ['Account', '/account']], 'a key once, in the Hub\'s order');
assert.deepEqual(accountNavEntries([{ key: 'goals', label: 'Evil', path: 'https://evil.example/' }]), [['Goals', '/goals']], 'a label or a path in the response is never used');
assert.deepEqual(accountNavEntries(['goals', null, 7, { key: 3 }, { key: '__proto__' }, { key: 'constructor' }, { key: 'toString' }]), [], 'not a key, or a key of Object.prototype: nothing');
for (const [key, [label, path]] of Object.entries(ACCOUNT_NAV)) assert.ok(/^[A-Z]/.test(label) && /^\/[a-z-]/.test(path) && !path.includes('//') && !/^\/\//.test(path), `${key}: a fixed label and a same-origin path: ${path}`);
console.log('account_nav: ok');
