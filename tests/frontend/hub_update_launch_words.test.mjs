// #13258: Settings says "On (set at launch)" beside the Hub update switch when --allow-hub-update / CORAL_ALLOW_HUB_UPDATE set it: the same sentence as On, with where it came from; the other states are unchanged.
import assert from 'node:assert/strict';
import { HUB_RELAUNCH_ON, HUB_RELAUNCH_OFF, HUB_RELAUNCH_AT_LAUNCH, HUB_RELAUNCH_OFF_AT_LAUNCH, HUB_RELAUNCH_OFF_TOAST_AT_LAUNCH } from '../../coral-go/pkg/frontend/static/update_words.js';

assert.match(HUB_RELAUNCH_AT_LAUNCH, /^On \(set at launch\): the owner of this Coral at Coral Hub can install the downloaded update/);
assert.ok(HUB_RELAUNCH_AT_LAUNCH.replace('On (set at launch)', 'On').startsWith(HUB_RELAUNCH_ON), 'the origin is added: what turning it on lets the Hub do is said the same');
assert.match(HUB_RELAUNCH_AT_LAUNCH, /lasts only until the next start: remove --allow-hub-update or CORAL_ALLOW_HUB_UPDATE/, 'Security SHOULD: an off here is only until the next start while the flag is set');
assert.match(HUB_RELAUNCH_OFF_AT_LAUNCH, /^Off until the next start: .*turns it on again then/);
assert.match(HUB_RELAUNCH_OFF_TOAST_AT_LAUNCH, /^Saved\. .*until the next start: --allow-hub-update or CORAL_ALLOW_HUB_UPDATE turns it on again then\.$/);
assert.notEqual(HUB_RELAUNCH_AT_LAUNCH, HUB_RELAUNCH_OFF);
assert.match(HUB_RELAUNCH_OFF, /^Off: /);
console.log('hub_update_launch_words: ok');

// The Update pane reads the same flag through fetchHubRelaunch: true while the server was started with the flag, whatever the switch says now.
const { fetchHubRelaunch, hubRelaunchSetAtLaunch } = await import('../../coral-go/pkg/frontend/static/update_api.js');
const answer = body => { globalThis.fetch = async () => ({ ok: true, json: async () => body }); };
answer({ hub_relaunch_updates: true, hub_relaunch_updates_at_launch: true });
assert.equal(await fetchHubRelaunch(), true); assert.equal(hubRelaunchSetAtLaunch(), true, 'on and set at launch');
answer({ hub_relaunch_updates: true });
assert.equal(await fetchHubRelaunch(), true); assert.equal(hubRelaunchSetAtLaunch(), false, 'on, turned on in Settings');
answer({ hub_relaunch_updates: false, hub_relaunch_updates_at_launch: true });
assert.equal(await fetchHubRelaunch(), false); assert.equal(hubRelaunchSetAtLaunch(), true, 'off now, but the flag is set: it comes back at the next start, and the pane says so');
globalThis.fetch = async () => { throw new Error('offline'); };
assert.equal(await fetchHubRelaunch(), null); assert.equal(hubRelaunchSetAtLaunch(), false, 'unknown: no words');
console.log('hub_update_launch_words (pane): ok');
