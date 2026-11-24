// The Limit waits card of the Cost page (#21020, the approved stage-1 mock #21017): the day words, the model of the read (an answer without its totals is a failed read, never zeros) and the card's text: the
// heading, the sentence, the three counts, the rows and the note on "early", as the mock has them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
const m = await importUi('analytics_limit_waits');

const MOCK = { tracking: true, waiting: 0, teams: ['alpha', 'beta'], totals: { waits: 7, at_reset: 5, early: 2 }, rows: [
    { agent: 'Lead Developer', day: '2026-11-23', waits: 3, at_reset: 2, early: 1 }, { agent: 'QA Engineer', day: '2026-11-23', waits: 2, at_reset: 2, early: 0 },
    { agent: 'Lead Developer', day: '2026-11-22', waits: 2, at_reset: 1, early: 1 }] };

test('a day is said as the mock says it, with no time zone in it', () => {
    assert.equal(m.dayWords('2026-11-23'), 'Mon 23 Nov');
    assert.equal(m.dayWords('2026-11-22'), 'Sun 22 Nov');
    assert.equal(m.dayWords('2026-01-01'), 'Thu 1 Jan');
    assert.equal(m.dayWords('not a day'), 'not a day');
    assert.equal(m.dayWords(undefined), '');
});

test('the range of the page is whole days: an hour or a day is today', () => {
    assert.deepEqual(['hour', 'day', 'week', 'month', 'other'].map(m.daysFor), [1, 1, 7, 30, 7]);
});

test('the model keeps the numbers and drops what is not a row', () => {
    const model = m.limitWaitsModel(MOCK);
    assert.deepEqual(model.totals, { waits: 7, atReset: 5, early: 2 });
    assert.deepEqual(model.rows.map(r => [r.agent, r.day, r.waits, r.atReset, r.early]), [['Lead Developer', '2026-11-23', 3, 2, 1], ['QA Engineer', '2026-11-23', 2, 2, 0], ['Lead Developer', '2026-11-22', 2, 1, 1]]);
    assert.deepEqual(model.teams, ['alpha', 'beta']);
    const odd = m.limitWaitsModel({ totals: { waits: -1, at_reset: 'x', early: 2.4 }, rows: [null, { day: 'x' }, { agent: 'A', day: '2026-11-23', waits: 1.2, at_reset: NaN, early: undefined }], teams: [3, '', 'ok'] });
    assert.deepEqual(odd.totals, { waits: 0, atReset: 0, early: 2 });
    assert.equal(odd.rows.length, 1);
    assert.deepEqual(odd.rows[0], { agent: 'A', day: '2026-11-23', waits: 1, atReset: 0, early: 0 });
    assert.deepEqual(odd.teams, ['ok']);
});

test('an answer without its totals or rows is not an answer', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { totals: {} }, { rows: [] }, { totals: 'x', rows: [] }, { totals: {}, rows: 'x' }]) assert.equal(m.limitWaitsModel(bad), null, JSON.stringify(bad));
});

test('a computer whose record is not open says nothing is counted, not zero waits', () => {
    assert.equal(m.limitWaitsModel({ tracking: false, totals: { waits: 0, at_reset: 0, early: 0 }, rows: [] }).tracking, false);
    assert.equal(m.limitWaitsModel({ totals: { waits: 0, at_reset: 0, early: 0 }, rows: [] }).tracking, true);
});

test('the card has the mock\'s words: heading, sentence, three counts, the rows and the note', () => {
    const card = m.limitWaitsCard(m.limitWaitsModel(MOCK));
    const text = card.textContent.replace(/\s+/g, ' ');
    assert.ok(text.includes('Limit waits'));
    assert.ok(text.includes('When an agent hits its vendor limit it waits, then resumes at the reset time or earlier. Counted per agent and day.'));
    assert.deepEqual([...card.querySelectorAll('.lw-kpi')].map(k => [k.querySelector('b').textContent, k.querySelector('span').textContent]), [['7', 'limit waits'], ['5', 'resumed at reset'], ['2', 'resumed early']]);
    for (const w of ['Lead Developer', 'QA Engineer', 'Mon 23 Nov', 'Sun 22 Nov']) assert.ok(text.includes(w), w);
    assert.ok(text.includes('"Early" means Coral or you resumed the agent before the reset time the vendor gave.'));
    assert.equal(card.querySelectorAll('tbody tr').length, 3, 'one row per agent and day');
});

test('an empty range says so in a sentence, and a computer that counts nothing says that', () => {
    const none = m.limitWaitsCard(m.limitWaitsModel({ totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], tracking: true }));
    assert.ok(none.textContent.includes('No agent was stopped by a limit in this range.'));
    assert.deepEqual([...none.querySelectorAll('.lw-kpi b')].map(b => b.textContent), ['0', '0', '0']);
    const off = m.limitWaitsCard(m.limitWaitsModel({ totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], tracking: false }));
    assert.ok(off.textContent.includes('Limit waits are not being counted on this computer.'));
});

test('an agent name is text, never markup', () => {
    const card = m.limitWaitsCard(m.limitWaitsModel({ totals: { waits: 1, at_reset: 1, early: 0 }, rows: [{ agent: '<img src=x onerror=alert(1)>', day: '2026-11-23', waits: 1, at_reset: 1, early: 0 }] }));
    assert.equal(card.querySelector('img'), null);
    assert.ok(card.textContent.includes('<img src=x onerror=alert(1)>'));
});

test.after(() => dom.window.close());
