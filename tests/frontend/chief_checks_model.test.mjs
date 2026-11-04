import assert from 'node:assert/strict';
import { newCheck, sourceRows, triggerWords, runCheckQueue } from '../../coral-go/pkg/frontend/static/chief_checks_model.js';
assert.equal(newCheck({ team: 'chief', session_id: 'exact-session' }).wake_if_asleep, false);
assert.equal(sourceRows({ supported: false }, []), null);
assert.deepEqual(sourceRows({ supported: true, servers: [] }, []), []);
const rows = sourceRows({ supported: true, servers: [{ name: 'mail', scope: 'user', transport: 'stdio' }, { name: 'mail', scope: 'project', transport: 'stdio' }] }, [{ id: 9, source_key: 'user:mail:stdio' }]);
assert.equal(rows[0].check.id, 9); assert.equal(rows[1].check, null);
assert.equal(triggerWords({ delivery: 'failed', state: 'open' }), 'Delivery failed');
assert.equal(triggerWords({ delivery: 'failed', state: 'done' }), 'Done'); // the card still shows its delivery failure separately
assert.equal(triggerWords({ delivery: 'held', state: 'open' }), 'Delivery held');
assert.equal(triggerWords({ delivery: 'delivered', reminder: 'failed', state: 'open' }), 'Open'); // reminder has its own error, never "all clear"
assert.equal(triggerWords({ delivery: 'delivered', state: 'open', notify_mode: 'daily_brief', summary: 'Ready' }), 'Awaiting brief');
const attempts = [];
const result = await runCheckQueue([{ id: 1 }, { id: 2 }], async (id, key) => { attempts.push([id, key]); if (id === 1) throw new Error('Board unavailable'); return { id: 22 }; }, id => `retry-key-${id}`);
assert.deepEqual(attempts, [[1, 'retry-key-1'], [2, 'retry-key-2']]);
assert.equal(result[0].ok, false); assert.equal(result[0].error, 'Board unavailable');
assert.equal(result[1].ok, true); assert.equal(result[1].trigger.id, 22);
console.log('chief_checks_model: PASS (consent, distinct sources, honest trigger state, partial run failures)');
