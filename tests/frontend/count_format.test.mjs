// A count as a person reads it (#7803): K, M and B, one decimal; a figure that rounds up to the next unit moves into it ("1000.0K" and "15491.8M" are never shown); the task rows' lower-case k.
import assert from 'node:assert/strict';
import { compactCount, formatTokens } from '../../coral-go/pkg/frontend/static/format.js';
import { _formatTokenCount } from '../../coral-go/pkg/frontend/static/task_format.js';

const cases = [
    [0, '0'], [7, '7'], [999, '999'], [1000, '1.0K'], [1234, '1.2K'], [15400, '15.4K'], [999949, '999.9K'], [999950, '1.0M'], [999999, '1.0M'], [1000000, '1.0M'], [2500000, '2.5M'],
    [15491800000, '15.5B'], [999949999, '999.9M'], [999950000, '1.0B'], [1e9, '1.0B'], [123456789012, '123.5B'], [999949999999, '999.9B'], [999950000000, '1.0T'], [5e12, '5.0T'], [-1500, '-1.5K'], [-15491800000, '-15.5B'],
];
for (const [n, want] of cases) assert.equal(formatTokens(n), want, `formatTokens(${n})`);
assert.equal(compactCount(1500, 'k'), '1.5k');
assert.equal(compactCount(15491800000, 'k'), '15.5B', 'only the thousands have a lower-case letter');
assert.equal(formatTokens(999.9999999999997), '1.0K', 'a float that is nearly a thousand is a thousand'); assert.equal(formatTokens(100.00000000000003), '100'); assert.equal(formatTokens(12.34), '12.3'); assert.equal(formatTokens(0.04), '0');
assert.equal(formatTokens(NaN), 'NaN', 'a value that is not a number is not made up');
assert.equal(_formatTokenCount(null), '0');
assert.equal(_formatTokenCount(950), '950');
assert.equal(_formatTokenCount(2500), '2.5k');
assert.equal(_formatTokenCount(15491800000), '15.5B');
for (const n of [1, 12, 123, 1234, 12345, 123456, 999499, 999500, 1234567, 99999999, 987654321, 1e10, 5e12]) assert.doesNotMatch(formatTokens(n), /^\d{4,}/, `${n}: never four digits before the letter`);
console.log('count_format: ok');
