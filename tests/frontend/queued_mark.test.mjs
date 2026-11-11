import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { isQueued, timeMs } = await importUi('queued_mark');

// #15378: the Queued mark parses both times; as text a space-form time sorts below the T-form for the whole day.
const since = '2026-11-10T20:43:00Z';
assert.ok('2026-11-10 20:50:00' < since, 'premise: compared as text, a later space-form time looks EARLIER than the pause');
assert.equal(isQueued('2026-11-10 20:50:00', since), true, 'a later message in the space form is queued');
assert.equal(isQueued('2026-11-10T20:50:00Z', since), true);
assert.equal(isQueued('2026-11-10T20:42:59Z', since), false, 'a message before the pause is not');
assert.equal(isQueued('2026-11-10T20:43:00Z', since), true, 'the same second counts (the pause time has second precision)');
assert.equal(isQueued('2026-11-10T21:30:00+01:00', since), false, 'an offset is honoured: 21:30+01:00 is 20:30 UTC, before the pause');
assert.equal(isQueued('2026-11-10T22:50:00+02:00', since), true, 'and 22:50+02:00 is 20:50 UTC, after it');
assert.equal(isQueued('2026-11-10T20:50:00.250Z', since), true, 'fractions parse');
assert.equal(isQueued('2026-11-10T20:50:00Z', ''), false, 'a server with no pause time (older than #15331) marks nothing');
assert.equal(isQueued('2026-11-10T20:50:00Z', undefined), false);
assert.equal(isQueued('not a time', since), false, 'a time that does not parse is never queued');
assert.equal(isQueued(undefined, since), false);
assert.ok(Number.isNaN(timeMs('')));
console.log('queued_mark ok');
