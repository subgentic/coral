// compactFigure (format.js): the one figure format of the Analytics pages (#9516, UI/UX): K, M, B and T with no space, one decimal at most and no trailing zero; below 1,000 the plain number.
import assert from 'node:assert/strict';
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const { compactFigure } = await import('../../coral-go/pkg/frontend/static/format.js');
const cases = [[0, '0'], [1, '1'], [999, '999'], [1000, '1K'], [1049, '1K'], [1050, '1.1K'], [1499, '1.5K'], [9999, '10K'], [10000, '10K'], [99949, '99.9K'], [99950, '100K'], [517000, '517K'], [517049, '517K'], [999400, '999.4K'], [999949, '999.9K'], [999950, '1M'],
    [1000000, '1M'], [1234567, '1.2M'], [99999999, '100M'], [999949999, '999.9M'], [999950000, '1B'], [1e9, '1B'], [1.5e9, '1.5B'], [2.5e12, '2.5T'], [-1234567, '-1.2M'], [12.34, '12.3'], [0.04, '0'], [99.5, '99.5'], [150.4, '150']];
for (const [n, want] of cases) assert.equal(compactFigure(n), want, `${n}`);
assert.equal(compactFigure('x'), 'x');
assert.equal(compactFigure(NaN), 'NaN');
console.log(`compact_figure: ok (${cases.length} figures)`);
