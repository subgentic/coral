// start_bytes_delta.mjs (#17762): the parsing of the Go test's line and the verdict, on fixtures.
import assert from 'node:assert/strict';
import { parseWeights, compare, baseRefFrom, GROWTH_HINT } from './start_bytes_delta.mjs';

const LINE = '    start_weight_test.go:66: app.js 426186 (baseline 418000, ceiling 426360), css 106042 (baseline 106000, ceiling 108120)\n--- PASS: TestStartPathWeight (0.67s)\n';
assert.deepEqual(parseWeights(LINE), { app: 426186, css: 106042 });
assert.equal(parseWeights('--- SKIP: TestStartPathWeight\n'), null, 'a skipped test has no numbers');
assert.equal(parseWeights(''), null);

const same = compare({ app: 100, css: 50 }, { app: 100, css: 50 });
assert.equal(same.grew, false);
assert.equal(compare({ app: 100, css: 50 }, { app: 90, css: 50 }).grew, false, 'a smaller start path passes');
assert.equal(compare({ app: 100, css: 50 }, { app: 101, css: 50 }).grew, true, 'one byte more in app.js fails');
assert.equal(compare({ app: 100, css: 50 }, { app: 100, css: 51 }).grew, true, 'one byte more in the start CSS fails');
assert.equal(compare({ app: 100, css: 50 }, { app: 90, css: 60 }).grew, true, 'a gain in one cannot pay for the other');
assert.equal(compare({ app: 426249, css: 106027 }, { app: 426186, css: 106042 }).line, 'app.js base 426249 head 426186 (-63), start CSS base 106027 head 106042 (+15) (gz -9)');
// the base (#18287): the argument wins, then CORAL_START_BASE, else '' (the merge-base with origin/main)
assert.equal(baseRefFrom('main', { CORAL_START_BASE: 'trial' }), 'main');
assert.equal(baseRefFrom(undefined, { CORAL_START_BASE: ' trial-base ' }), 'trial-base', 'a trial branch is compared with its own base');
assert.equal(baseRefFrom(undefined, {}), '');
assert.equal(baseRefFrom(undefined, { CORAL_START_BASE: '' }), '');
// a failure says to fetch, and how a trial branch sets its base
assert.match(GROWTH_HINT, /git fetch origin main/);
assert.match(GROWTH_HINT, /CORAL_START_BASE/);
console.log('start_bytes_delta: ok');
