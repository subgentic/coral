// The lines over time (#7857): the axis has a point for every interval (a time with no usage is a zero), the colours follow the ranking by cost (not the metric shown), the top 7 are their own lines and the
// rest are one Other, a running total ends on the sum, and "Totals agree" is a comparison a float cannot break.
import assert from 'node:assert/strict';
import { axis, bucketStart, rankKeys, assignLines, buildSeries, buildMetricLines, metricUnits, METRIC_SLOT, agrees, changeText, bucketTotals, priorWord, cacheHit, bucketWindow, TOP, OTHER, METRICS } from '../../coral-go/pkg/frontend/static/analytics_series.js';

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
let lines = buildSeries(buckets, assignLines(rankKeys(buckets), null), times, 'cost_usd', false);
assert.deepEqual(lines.map(l => l.key), ['b', 'a', 'c']);
assert.deepEqual(lines[1].vals, [1, 0, 2, 0], 'a time with no usage is a zero');
lines = buildSeries(buckets, assignLines(rankKeys(buckets), null), times, 'cost_usd', true);
assert.deepEqual(lines[1].plot, [1, 1, 3, 3], 'a running total');
assert.equal(lines[1].total, 3, 'and its total is what the table row says');
assert.equal(lines.reduce((a, l) => a + l.total, 0), 7.75);
// the same entity keeps its rank, so its colour, when another metric is shown
const byInput = buildSeries(buckets, assignLines(rankKeys(buckets), null), times, 'input_tokens', false);
assert.deepEqual(byInput.map(l => l.key), ['b', 'a', 'c']);
assert.deepEqual(byInput[1].vals, [100, 0, 300, 0]);

// more than 7: the rest are one Other line, and the sum is kept
const many = Array.from({ length: 10 }, (_, i) => ser('k' + i, 10 - i, 0, 2));
const mb = [{ bucket: iso(t0), series: many }];
const ranked = rankKeys(mb), ml = buildSeries(mb, assignLines(ranked, null), [t0], 'cost_usd', false);
assert.equal(ml.length, TOP + 1);
assert.deepEqual(ml.slice(0, TOP).map(l => l.key), ranked.slice(0, TOP));
const other = ml[TOP];
assert.deepEqual([other.key, other.other, other.label, other.total], [OTHER, true, 'Other (3)', 3 + 2 + 1]);
assert.equal(ml.reduce((a, l) => a + l.total, 0), 55, 'the lines add up to the whole');
assert.equal(buildSeries(mb, assignLines(ranked.slice(0, 3), null), [t0], 'cost_usd', false).length, 3, 'up to the top 7 there is no Other');
// a bucket off the axis is not counted twice or lost into another
assert.equal(buildSeries([{ bucket: iso(t0 + 99 * H), series: [ser('a', 5)] }], assignLines(['a'], null), times, 'cost_usd', false)[0].total, 0);

assert.ok(agrees(0.1 + 0.2, 0.3), 'a float sum is the same figure');
assert.ok(!agrees(1, 1.01));
assert.ok(agrees(15491800000, 15491800000.4));
assert.deepEqual(METRICS.map(m => m.table), ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'requests']);
// the change against the period before: signed words, never a colour, and no claim without something to compare
assert.equal(changeText(112, 100, 'the prior 24 hours'), '+12% vs the prior 24 hours');
assert.equal(changeText(97, 100, 'the prior 7 days'), '\u22123% vs the prior 7 days');
assert.equal(changeText(100, 100, 'the hour before'), 'no change vs the hour before');
assert.equal(changeText(5, 0, 'the prior 24 hours'), 'no usage in the prior 24 hours');
assert.equal(changeText(0, 0, 'x'), '');
assert.equal(changeText(0, 10, 'the prior 24 hours'), '\u2212100% vs the prior 24 hours');
assert.equal(priorWord('week'), 'the prior 7 days'); assert.equal(priorWord('nothing'), 'the prior 24 hours');
assert.deepEqual(bucketTotals([{ cost_usd: 1, input_tokens: 5, num_requests: 2 }, { cost_usd: 2.5, output_tokens: 7 }]), { cost_usd: 3.5, input_tokens: 5, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: 2 });
// the agent drill-down: the cache hit is read / (input + read), none without input; a clicked bar is its bucket to the next one (the end exclusive, as the server reads it)
assert.equal(cacheHit(100, 900), 0.9); assert.equal(cacheHit(0, 0), null); assert.equal(cacheHit(50, 0), 0);
assert.deepEqual(bucketWindow(Date.UTC(2026, 9, 25, 10), '1h'), { since: '2026-10-25T10:00:00.000Z', until: '2026-10-25T11:00:00.000Z' });
assert.deepEqual(bucketWindow(Date.UTC(2026, 9, 25), '1d'), { since: '2026-10-25T00:00:00.000Z', until: '2026-10-26T00:00:00.000Z' });
// rows checked: only those have lines; a checked row keeps the colour it had in the top; one that was not takes a colour no checked row has; more checked than colours fold into Other
const rk = Array.from({ length: 10 }, (_, i) => 'k' + i);
let a = assignLines(rk, null);
assert.deepEqual(a.lines.map(l => [l.key, l.slot]), rk.slice(0, 7).map((k, i) => [k, i])); assert.deepEqual(a.folded, ['k7', 'k8', 'k9']); assert.equal(a.active, false);
a = assignLines(rk, new Set(['k1', 'k8', 'nobody']));
assert.deepEqual(a.lines.map(l => [l.key, l.slot]), [['k1', 1], ['k8', 0]], 'k1 keeps colour 1, k8 takes the first colour no checked row has');
assert.deepEqual([a.folded, a.active], [[], true]);
a = assignLines(rk, new Set(rk));
assert.equal(a.lines.length, 7); assert.deepEqual(a.folded, ['k7', 'k8', 'k9'], 'all ten checked: the same as none');
a = assignLines(rk, new Set(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k9']));
assert.deepEqual(a.folded, ['k7', 'k9'], 'nine checked, seven colours: the two that do not fit are Other');
assert.deepEqual(assignLines(rk, new Set()).active, false, 'nothing checked is the default');
// the lines of a checked set add up to its rows, folded keys into Other
const cb = [{ bucket: iso(t0), series: [ser('a', 1), ser('b', 2), ser('c', 4)] }];
const al = assignLines(['c', 'b', 'a'], new Set(['a', 'b']), 1);
const cl = buildSeries(cb, al, [t0], 'cost_usd', false);
assert.deepEqual(cl.map(l => [l.key, l.total, l.other]), [['b', 2, false], [OTHER, 1, true]], 'with one colour, the second checked row is Other, and c (not checked) is not drawn');
// several metrics of one row: a line per metric, in the metric's own colour; tokens share a chart, dollars and requests are apart
const mm = METRICS.filter(m => ['input_tokens', 'cache_read_tokens', 'cost_usd'].includes(m.key));
const ml2 = buildMetricLines([{ bucket: iso(t0), series: [{ key: 'a', cost_usd: 1, input_tokens: 5, cache_read_tokens: 50, cache_write_tokens: 0, output_tokens: 0, num_requests: 1 }, { key: 'b', cost_usd: 9, input_tokens: 9, cache_read_tokens: 9 }] }], ['a'], [t0], mm, false);
assert.deepEqual(ml2.map(l => [l.key, l.slot, l.total]), [['cost_usd', METRIC_SLOT.cost_usd, 1], ['input_tokens', METRIC_SLOT.input_tokens, 5], ['cache_read_tokens', METRIC_SLOT.cache_read_tokens, 50]], 'in the order of the picker');
assert.deepEqual(metricUnits(mm).map(g => g.map(m => m.key)), [['cost_usd'], ['input_tokens', 'cache_read_tokens']]);
assert.deepEqual(metricUnits(METRICS).map(g => g.length), [1, 4, 1]);
console.log('analytics_series: ok');
