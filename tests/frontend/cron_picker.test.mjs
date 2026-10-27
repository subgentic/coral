// The schedule pickers' cron expressions (Automations #4): each picker state composes the expression the server takes and reads back; an expression no picker can say is null (the Advanced box keeps it).
import assert from 'node:assert/strict';
import { composeCron, parseCron } from '../../coral-go/pkg/frontend/static/cron_picker.js';

const cases = [
    [{ mode: 'minutes', n: 1 }, '* * * * *'], [{ mode: 'minutes', n: 15 }, '*/15 * * * *'], [{ mode: 'minutes', n: 59 }, '*/59 * * * *'],
    [{ mode: 'hours', n: 1 }, '0 * * * *'], [{ mode: 'hours', n: 6 }, '0 */6 * * *'], [{ mode: 'hours', n: 23 }, '0 */23 * * *'],
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
assert.equal(composeCron({ mode: 'minutes', n: 500 }), '*/59 * * * *', 'minutes are clamped to 59');
assert.equal(composeCron({ mode: 'hours', n: 0 }), '0 * * * *', 'hours are at least 1');
assert.deepEqual([...parseCron('0 9 * * 1-5').days].sort(), [1, 2, 3, 4, 5], 'a range of days');
assert.deepEqual([...parseCron('0 9 * * 7').days], [0], 'Sunday as 7 is 0');
for (const e of ['', 'nonsense', '0 5 1 * *', '*/5 9-17 * * 1-5', '0 */1 * * *', '*/1 * * * *', '60 1 * * *', '0 24 * * *', '0 9 * * 5-1', '0 0 * * MON']) assert.equal(parseCron(e), null, 'only Advanced can say: ' + e);
console.log('cron_picker: ok (' + cases.length + ' picker states compose and read back; shapes no picker says stay in Advanced)');
