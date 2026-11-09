import assert from 'node:assert/strict';
globalThis.location = new URL('https://hub.test/');
globalThis.document = { getElementById: id => id === 'coral-boot' ? { textContent: '{"mode":"cloud"}' } : null, querySelector: () => null };
globalThis.window = {};
const { state } = await import('../../coral-go/pkg/frontend/static/state.js');
const { personalInboxSources, personalInboxAllowed, personalInboxNotice } = await import('../../coral-go/pkg/frontend/static/server_base.js');
state.servers = [
 { id: 'owned', owner: true, status: 'online', effective_mode: 'view' },
 { id: 'granted', owner: false, owner_stamp: true, status: 'online', effective_mode: 'launch' },
 { id: 'unknown', status: 'online', effective_mode: 'interact' },
 { id: 'malformed', owner: 'true', status: 'online', effective_mode: 'launch' },
 { id: 'offline', owner: true, status: 'offline', effective_mode: 'launch' },
 { id: '../escape', owner: true, status: 'online', effective_mode: 'launch' },
 { id: 'local', owner: true, status: 'online', effective_mode: 'launch' },
];
assert.equal(personalInboxAllowed('owned'), true);
assert.equal(personalInboxAllowed('owned', true), false);
for (const id of ['granted', 'unknown', 'malformed', 'offline', '../escape', 'local']) {
 assert.equal(personalInboxAllowed(id), false, id+' has no personal reads');
 assert.equal(personalInboxAllowed(id, true), false, id+' has no reply');
}
for (const mode of ['interact', 'launch']) {
 state.servers[0].effective_mode = mode;
 assert.equal(personalInboxAllowed('owned', true), true);
}
state.servers[0].effective_mode = undefined;
assert.equal(personalInboxAllowed('owned', true), false, 'unknown mode cannot reply');
assert.equal(personalInboxSources().length, 5, 'malformed routing sources are dropped');
assert.match(personalInboxNotice('Saved'), /Only this computer's owner/);
assert.match(personalInboxNotice('Saved'), /Ownership is not known/);
const { nativeSavedSourceAllowed } = await import('../../coral-go/pkg/frontend/static/server_status.js');
for (const version of [undefined, '2.0.61', '2.0.62-rc.1']) { state.servers[0].coral_version = version; assert.equal(nativeSavedSourceAllowed('owned'), false, 'Saved withholds an unknown or older version'); }
for (const version of ['2.0.62', '2.0.63']) { state.servers[0].coral_version = version; assert.equal(nativeSavedSourceAllowed('owned'), true); }
state.servers = [];
assert.match(personalInboxNotice('Saved'), /Waiting for computer ownership/);
console.log('personal_inbox_policy: strict ownership, mode and source boundaries pass');
