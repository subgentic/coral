// start_bytes_delta.mjs (#17762): the parsing of the Go test's line and the verdict, on fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWeights, compare, baseRefFrom, GROWTH_HINT, ACCEPTED_START_CSS } from './start_bytes_delta.mjs';

const LINE = '    start_weight_test.go:66: app.js 426186 (baseline 418000, ceiling 426360), css 106042 (baseline 106000, ceiling 108120)\n--- PASS: TestStartPathWeight (0.67s)\n';
assert.deepEqual(parseWeights(LINE), { app: 426186, css: 106042, go: null }, 'an old line without a version still parses');
// The line the Go test logs, pinned on both sides by one fixture (start_weight_test.go checks it is what startWeightLine builds).
assert.deepEqual(parseWeights(readFileSync(new URL('./fixtures/start_weight_line.txt', import.meta.url), 'utf8')), { app: 426186, css: 106042, go: 'go1.26.1' });
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
const ok = compare({ app: 100, css: 50, go: 'go1.26.1' }, { app: 100, css: 50, go: 'go1.26.1' });
assert.equal(ok.verdict, 'start bytes: OK (go1.26.1)');
assert.equal(compare({ app: 100, css: 50, go: 'go1.27.0' }, { app: 141, css: 50, go: 'go1.27.0' }).verdict, 'GREW: app.js +41 gz / CSS 0 gz (MUST) (go1.27.0)');
assert.equal(compare({ app: 100, css: 50, go: 'x' }, { app: 100, css: 60, go: 'x' }).verdict, 'GREW: app.js 0 gz / CSS +10 gz (MUST) (x)');
console.log('start_bytes_delta: ok');

// 2.0.69's accepted start CSS (#18817): up to ACCEPTED_START_CSS passes, one byte over fails, and app.js never gets an allowance
assert.equal(compare({ app: 100, css: 50 }, { app: 100, css: 60 }, 60).grew, false, 'CSS up to the accepted size passes');
assert.equal(compare({ app: 100, css: 50 }, { app: 100, css: 61 }, 60).grew, true, 'one byte over the accepted size fails');
assert.equal(compare({ app: 100, css: 50 }, { app: 101, css: 50 }, 60).grew, true, 'app.js has no allowance');
assert.equal(ACCEPTED_START_CSS, 106343, 'rc4 measured size (Orchestrator decision on #18817)');
