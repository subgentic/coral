// #13425: the home-folder question's answer handling: only a 409 with code home_folder is the question; Launch/Wake anyway resolves true; Cancel, Escape or a replaced dialog resolves false.
import assert from 'node:assert/strict';
import { isHomeFolderAsk, askHomeFolder } from '../../coral-go/pkg/frontend/static/home_folder_ask.js';

assert.equal(isHomeFolderAsk(409, { code: 'home_folder' }), true);
assert.equal(isHomeFolderAsk(409, { code: 'board_name_exists' }), false, 'another 409 is not this question');
assert.equal(isHomeFolderAsk(200, { code: 'home_folder' }), false);
assert.equal(isHomeFolderAsk(409, null), false);
assert.equal(isHomeFolderAsk(409, undefined), false);

let seen;
const yes = (title, message, onConfirm, onCancel, opts) => { seen = { title, message, opts }; onConfirm(); onCancel(); }; // a late cancel after the answer changes nothing
assert.equal(await askHomeFolder('Launch', 'ask text', yes), true);
assert.equal(seen.title, 'Launch in your home folder?');
assert.equal(seen.message, 'ask text');
assert.equal(seen.opts.label, 'Launch anyway');
assert.equal(seen.opts.danger, false, 'a question, not a danger');
assert.equal(await askHomeFolder('Wake', '', (t, m, ok, no) => no()), false);
assert.equal(seen.opts.cancelLabel, 'Pick a folder');
assert.match((await (async () => { let m; await askHomeFolder('Wake', '', (t, mm, ok) => { m = mm; ok(); }); return m; })()), /whole home folder/, 'the default words');
console.log('home_folder_ask: ok');
