// The schedule pickers' cron expressions (Automations #4): each picker state composes the expression the server takes and reads back; an expression no picker can say is null (the Advanced box keeps it).
import assert from 'node:assert/strict';
import { composeCron, parseCron } from '../../coral-go/pkg/frontend/static/cron_picker.js';

const cases = [
    [{ mode: 'minutes', n: 1 }, '* * * * *'], [{ mode: 'minutes', n: 15 }, '*/15 * * * *'], [{ mode: 'minutes', n: 30 }, '*/30 * * * *'],
    [{ mode: 'hours', n: 1 }, '0 * * * *'], [{ mode: 'hours', n: 6 }, '0 */6 * * *'], [{ mode: 'hours', n: 12 }, '0 */12 * * *'],
    [{ mode: 'daily', at: '02:00' }, '0 2 * * *'], [{ mode: 'daily', at: '07:30' }, '30 7 * * *'], [{ mode: 'daily', at: '23:59' }, '59 23 * * *'],
    [{ mode: 'weekly', at: '09:00', days: new Set([1]) }, '0 9 * * 1'], [{ mode: 'weekly', at: '07:30', days: new Set([3, 1]) }, '30 7 * * 1,3'], [{ mode: 'weekly', at: '18:15', days: new Set([0, 6]) }, '15 18 * * 0,6'],
];
for (const [st, expr] of cases) {
    assert.equal(composeCron(st), expr, JSON.stringify([...Object.entries(st)]));
    const back = parseCron(expr);
    assert.equal(back.mode, st.mode, expr);
    assert.equal(composeCron({ ...st, ...back }), expr, 'round trip ' + expr);
}
assert.equal(composeCron({ mode: 'weekly', at: '09:00', days: new Set() }), '', 'a weekly schedule with no day is empty (the form asks for one)');
assert.equal(composeCron({ mode: 'minutes', n: 500 }), '*/30 * * * *', 'minutes snap to the largest step that divides the hour');
assert.equal(composeCron({ mode: 'minutes', n: 7 }), '*/6 * * * *', 'every 7 minutes would not be every 7 (the hour is not a multiple): the nearest step');
assert.equal(composeCron({ mode: 'hours', n: 0 }), '0 * * * *', 'hours are at least 1');
assert.equal(composeCron({ mode: 'hours', n: 7 }), '0 */6 * * *', 'every 7 hours would drift: the nearest step that divides the day (a tie takes the smaller)');
assert.equal(composeCron({ mode: 'daily', at: '27:99' }), '59 23 * * *', 'a time off the clock is the nearest time on it');
assert.equal(composeCron({ mode: 'daily', at: 'xx' }), '0 9 * * *', 'no time is 09:00');
assert.deepEqual([...parseCron('0 9 * * 1-5').days].sort(), [1, 2, 3, 4, 5], 'a range of days');
assert.deepEqual([...parseCron('0 9 * * 7').days], [0], 'Sunday as 7 is 0');
for (const e of ['', 'nonsense', '0 5 1 * *', '*/5 9-17 * * 1-5', '0 */1 * * *', '*/1 * * * *', '*/7 * * * *', '0 */7 * * *', '*/59 * * * *', '0 */23 * * *', '60 1 * * *', '0 24 * * *', '0 9 * * 5-1', '0 0 * * MON']) assert.equal(parseCron(e), null, 'only Advanced can say: ' + e);
console.log('cron_picker: ok (' + cases.length + ' picker states compose and read back; shapes no picker says stay in Advanced)');
