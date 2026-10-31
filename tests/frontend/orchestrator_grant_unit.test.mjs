// The Orchestrator access group's own words (#11432): the seat is the session id inside a member's session name, and a log row is read as one sentence of cleaned names, never as markup.
import assert from 'node:assert/strict';
import { seatOfName, logLine, OG_KEYS } from '../../coral-go/pkg/frontend/static/orchestrator_grant_words.js';

assert.equal(seatOfName('claude-4154e47a-ac42-6744-9d1e-07e94bb9a235'), '4154e47a-ac42-6744-9d1e-07e94bb9a235');
assert.equal(seatOfName(''), '');
assert.equal(seatOfName('nodash'), '');
assert.equal(logLine({ kind: 'wake', actor: 'Orchestrator', target: 'Dev', status: 'ok' }), 'Orchestrator woke Dev');
assert.equal(logLine({ kind: 'sleep', actor: 'Orchestrator', target: 'Dev2', status: 'failed' }), 'Orchestrator put to sleep Dev2 (failed)');
assert.equal(logLine({ kind: 'launch', actor: '', target: 'Helper', status: 'reserved' }), 'An agent started Helper (in progress)');
assert.equal(logLine({ kind: 'grant', actor: 'Operator', target: 'switch on, seat Orchestrator, 10 an hour, 8 live, idle 5 min', status: 'ok' }), 'Operator: setting changed: switch on, seat Orchestrator, 10 an hour, 8 live, idle 5 min');
assert.equal(logLine({ kind: 'surprise', actor: 'X', target: 'Y', status: 'ok' }), 'X did something to Y', 'a kind this build does not know is said plainly');
assert.deepEqual(OG_KEYS, ['og_enabled', 'og_seat', 'og_max_per_hour', 'og_max_live', 'og_idle_minutes']);
console.log('orchestrator grant unit ok');
