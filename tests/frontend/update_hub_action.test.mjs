// #13258: the Update button of a computer behind the hub: what it does is decided by that computer's own status (its hub_state word), in words of this build; an unknown word, or a status that is not an object, never opens the confirmation.
import assert from 'node:assert/strict';
globalThis.location = new URL('https://hub.test/');
globalThis.document = { getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.window = {};
const A = await import('../../coral-go/pkg/frontend/static/update_api.js');
const st = (o = {}) => A.normalizeStatus({ enabled: true, installed: '1.4.130', state: 'staged', relaunch: { available: true, ack: 'tok', restarts: [] }, ...o });

// the word is read from the closed set only
assert.equal(st({ hub_state: 'staged' }).hubState, 'staged');
assert.equal(st({ hub_state: 'rm -rf /' }).hubState, '', 'a word outside the set is nothing');
assert.equal(st({}).hubState, '', 'a computer that sends none: none');

// staged and verified and the relaunch open: the confirmation
assert.deepEqual(A.hubUpdateAction(st({ hub_state: 'staged', staged: { version: '1.4.131', verified: true } })), { kind: 'dialog' });
// staged but not verified: words, never the confirmation
let a = A.hubUpdateAction(st({ hub_state: 'staged', staged: { version: '1.4.131', verified: false } }));
assert.equal(a.kind, 'hint'); assert.match(a.text, /not verified/);
// staged, verified, but the relaunch is not open (a reason): that reason's words
a = A.hubUpdateAction(st({ hub_state: 'staged', staged: { version: '1.4.131', verified: true }, relaunch: { available: false, reason: 'hub_relaunch_off' } }));
assert.equal(a.kind, 'hint'); assert.match(a.text, /switched off on this computer/);
// the person's switch off: say where to turn it on, never open anything
a = A.hubUpdateAction(st({ hub_state: 'hub_relaunch_off' }));
assert.equal(a.kind, 'hint'); assert.match(a.text, /relaunch to install updates/); assert.match(a.text, /Settings/);
// a check running: wait; nothing checked or nothing new: ask the computer to check; a failed check: words
assert.equal(A.hubUpdateAction(st({ hub_state: 'checking' })).kind, 'wait');
assert.equal(A.hubUpdateAction(st({ hub_state: 'not_checked' })).kind, 'check');
assert.equal(A.hubUpdateAction(st({ hub_state: 'up_to_date' })).kind, 'check');
assert.equal(A.hubUpdateAction(st({ hub_state: 'failed' })).kind, 'hint');
// no status, or an old computer that sends no word: words, nothing opens
assert.equal(A.hubUpdateAction(null).kind, 'hint');
assert.equal(A.hubUpdateAction(st({})).kind, 'hint');
// the words are this build's: nothing the computer sent is in them
a = A.hubUpdateAction(st({ hub_state: 'hub_relaunch_off', error: '<img src=x onerror=alert(1)>' }));
assert.ok(!/img|onerror/.test(a.text));
assert.match(A.reasonText('relink_needed'), /Link it to Coral Hub again/);

// the requests: the status of a computer behind the hub goes through its proxy, the check is a POST with no body
const sent = [];
globalThis.fetch = async (url, o = {}) => { sent.push([String(url), (o.method || 'GET'), o.body]); return Response.json({ hub_state: 'staged', enabled: true, state: 'staged', staged: { version: '1.4.131', verified: true }, relaunch: { available: true } }, { status: o.method === 'POST' ? 202 : 200 }); };
const s = await A.fetchUpdateStatusOf('box-2');
assert.equal(s.hubState, 'staged'); assert.equal(sent[0][0], '/api/remote/box-2/api/system/update');
const r = await A.requestHubCheck('box-2');
assert.equal(r.ok, true); assert.deepEqual(sent[1], ['/api/remote/box-2/api/system/update/check-hub', 'POST', undefined], 'one POST, no body, no query');
console.log('update_hub_action: ok');
