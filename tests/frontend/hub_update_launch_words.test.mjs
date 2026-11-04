// #13258: Settings says "On (set at launch)" beside the Hub update switch when --allow-hub-update / CORAL_ALLOW_HUB_UPDATE set it: the same sentence as On, with where it came from; the other states are unchanged.
import assert from 'node:assert/strict';
import { HUB_RELAUNCH_ON, HUB_RELAUNCH_OFF, HUB_RELAUNCH_AT_LAUNCH } from '../../coral-go/pkg/frontend/static/update_words.js';

assert.match(HUB_RELAUNCH_AT_LAUNCH, /^On \(set at launch\): the owner of this Coral at Coral Hub can install the downloaded update/);
assert.equal(HUB_RELAUNCH_AT_LAUNCH.replace('On (set at launch)', 'On'), HUB_RELAUNCH_ON, 'only the origin is added: what turning it on lets the Hub do is said the same');
assert.notEqual(HUB_RELAUNCH_AT_LAUNCH, HUB_RELAUNCH_OFF);
assert.match(HUB_RELAUNCH_OFF, /^Off: /);
console.log('hub_update_launch_words: ok');
