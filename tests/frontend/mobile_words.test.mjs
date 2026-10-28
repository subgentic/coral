// The words of the "Use on your phone" dialog (#10149, Desktop tester #10148): what Enable does, where the phone types the setup code, and the same-network line. Plain text for textContent.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const W = await import(path.resolve(here, '../../coral-go/pkg/frontend/static/mobile_words.js'));

// what Enable does, before it is pressed, and the Hub way as a named choice
assert.match(W.DISABLED_WORDS, /Turning it on lets devices on your network reach Coral/);
assert.match(W.DISABLED_WORDS, /they need your password or a setup code/);
assert.match(W.DISABLED_WORDS, /Coral Hub, which needs no network access/);
assert.equal(W.USE_HUB_LABEL, 'Use Coral Hub instead');
assert.equal(W.ENABLE_LABEL, 'Enable');

// the one panel: the address, where the setup code is typed, and the network line
assert.match(W.OPEN_ON_PHONE, /Open this address on your phone/); assert.match(W.OPEN_ON_PHONE, /Add to Home Screen/);
assert.match(W.SAME_NETWORK, /same network as this computer/);
assert.match(W.SETUP_CODE_WHERE, /phone asks for the setup code/); assert.match(W.SETUP_CODE_WHERE, /creates your password/); assert.match(W.SETUP_CODE_WHERE, /this computer's own browser never asks/i);
assert.match(W.NO_SETUP_CODE, /password/); assert.match(W.NO_SETUP_CODE, /coral setup-code/);

// the code's hint: once, and for how long
assert.equal(W.setupCodeHint(300), 'It works once and is valid for about 5 more minutes. It hides itself in a minute.');
assert.equal(W.setupCodeHint(60), 'It works once and is valid for about 1 more minute. It hides itself in a minute.');
assert.equal(W.setupCodeHint(0), 'It works once and is valid for about 1 more minute. It hides itself in a minute.');
assert.equal(W.SHOW_CODE, 'Show setup code'); assert.equal(W.HIDE_CODE, 'Hide setup code');
assert.equal(W.CODE_SHOW_MS, 60000);
console.log('mobile_words: ok');
