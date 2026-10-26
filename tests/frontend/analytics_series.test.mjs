// The lines over time (#7857): the axis has a point for every interval (a time with no usage is a zero), the colours follow the ranking by cost (not the metric shown), the top 7 are their own lines and the
// rest are one Other, a running total ends on the sum, and "Totals agree" is a comparison a float cannot break.
import assert from 'node:assert/strict';
import { axis, bucketStart, rankKeys, buildSeries, agrees, TOP, OTHER, METRICS } from '../../coral-go/pkg/frontend/static/analytics_series.js';

const H = 3600000, t0 = Date.UTC(2026, 9, 25, 10, 0, 0);
assert.equal(bucketStart(t0 + 1234, '1h'), t0);
assert.equal(bucketStart(t0 + 7 * 60000, '5m'), t0 + 5 * 60000);
assert.deepEqual(axis(t0 + 5, t0 + 3 * H, '1h'), [t0, t0 + H, t0 + 2 * H, t0 + 3 * H], 'every hour from the one the range starts in to now');
assert.equal(axis(t0, t0 + 10 * 86400000 * 400, '1h').length, 2000, 'bounded');

const iso = ms => new Date(ms).toISOString();
const ser = (key, cost, input = 0, n = 1) => ({ key, label: key, cost_usd: cost, input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: n });
const buckets = [
    { bucket: iso(t0), series: [ser('a', 1, 100), ser('b', 4, 10), ser('c', 0.5, 5)] },
    { bucket: iso(t0 + 2 * H), series: [ser('a', 2, 300), ser('c', 0.25, 1)] },
];
assert.deepEqual(rankKeys(buckets), ['b', 'a', 'c'], 'the dearest first, whatever metric is shown');
const times = axis(t0, t0 + 3 * H, '1h');
let lines = buildSeries(buckets, rankKeys(buckets), times, 'cost_usd', false);
assert.deepEqual(lines.map(l => l.key), ['b', 'a', 'c']);
assert.deepEqual(lines[1].vals, [1, 0, 2, 0], 'a time with no usage is a zero');
lines = buildSeries(buckets, rankKeys(buckets), times, 'cost_usd', true);
assert.deepEqual(lines[1].plot, [1, 1, 3, 3], 'a running total');
assert.equal(lines[1].total, 3, 'and its total is what the table row says');
assert.equal(lines.reduce((a, l) => a + l.total, 0), 7.75);
// the same entity keeps its rank, so its colour, when another metric is shown
const byInput = buildSeries(buckets, rankKeys(buckets), times, 'input_tokens', false);
assert.deepEqual(byInput.map(l => l.key), ['b', 'a', 'c']);
assert.deepEqual(byInput[1].vals, [100, 0, 300, 0]);

// more than 7: the rest are one Other line, and the sum is kept
const many = Array.from({ length: 10 }, (_, i) => ser('k' + i, 10 - i, 0, 2));
const mb = [{ bucket: iso(t0), series: many }];
const ranked = rankKeys(mb), ml = buildSeries(mb, ranked, [t0], 'cost_usd', false);
assert.equal(ml.length, TOP + 1);
assert.deepEqual(ml.slice(0, TOP).map(l => l.key), ranked.slice(0, TOP));
const other = ml[TOP];
assert.deepEqual([other.key, other.other, other.label, other.total], [OTHER, true, 'Other (3)', 3 + 2 + 1]);
assert.equal(ml.reduce((a, l) => a + l.total, 0), 55, 'the lines add up to the whole');
assert.equal(buildSeries(mb, ranked.slice(0, 3), [t0], 'cost_usd', false).length, 3, 'up to the top 7 there is no Other');
// a bucket off the axis is not counted twice or lost into another
assert.equal(buildSeries([{ bucket: iso(t0 + 99 * H), series: [ser('a', 5)] }], ['a'], times, 'cost_usd', false)[0].total, 0);

assert.ok(agrees(0.1 + 0.2, 0.3), 'a float sum is the same figure');
assert.ok(!agrees(1, 1.01));
assert.ok(agrees(15491800000, 15491800000.4));
assert.deepEqual(METRICS.map(m => m.table), ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'requests']);
console.log('analytics_series: ok');
