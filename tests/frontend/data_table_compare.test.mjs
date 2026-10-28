// data_table's column sort (compareBy), the part every sortable table shares (#9680, QA Reviewer 2): sort 'date' takes a number (a time in ms) as it is and reads a string with Date.parse, so a column that
// keeps its times as numbers sorts instead of tying (Date.parse of a number is NaN: every row was 0). Numbers, ISO strings, empty values, and the text sort. Run: node data_table_compare.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { compareBy } = await importUi('data_table');
const order = (col, rows) => rows.slice().sort(compareBy(col)).map(r => r.id);
const date = { sort: 'date', sortValue: r => r.t };

assert.deepEqual(order(date, [{ id: 'new', t: 1730000000000 }, { id: 'old', t: 1720000000000 }, { id: 'mid', t: 1725000000000 }]), ['old', 'mid', 'new'], 'numbers (ms) sort by size, not as a tie');
assert.deepEqual(order(date, [{ id: 'now', t: Number.MAX_SAFE_INTEGER }, { id: 'old', t: 1720000000000 }, { id: 'none', t: 0 }]), ['none', 'old', 'now'], 'a far-future number (an online machine) sorts after any time, zero first');
assert.deepEqual(order(date, [{ id: 'new', t: '2026-10-27T10:00:00Z' }, { id: 'old', t: '2026-10-13T00:00:00Z' }]), ['old', 'new'], 'ISO strings still sort by time');
assert.deepEqual(order(date, [{ id: 'iso', t: '2026-10-27T10:00:00Z' }, { id: 'empty', t: '' }, { id: 'undef', t: undefined }, { id: 'junk', t: 'not a date' }]).slice(0, 3).sort(), ['empty', 'junk', 'undef'], 'empty, missing and unreadable values count as zero: they come before a real time');
assert.equal(order(date, [{ id: 'iso', t: '2026-10-27T10:00:00Z' }, { id: 'empty', t: '' }]).at(-1), 'iso');
assert.deepEqual(order({ sort: 'number', sortValue: r => r.t }, [{ id: 'b', t: 10 }, { id: 'a', t: 9 }, { id: 'c', t: '11' }]), ['a', 'b', 'c'], 'sort number: numbers and numeric strings by size');
assert.deepEqual(order({ sortValue: r => r.t }, [{ id: 'b', t: 'Box 10' }, { id: 'a', t: 'box 9' }]), ['a', 'b'], 'text: natural order, case ignored');
console.log('data_table_compare: ok (date sort takes numbers, ISO strings and empty values; number and text sorts)');
