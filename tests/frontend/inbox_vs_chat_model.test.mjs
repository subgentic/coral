// The Inbox-versus-chat tab's model (#12158): the day grid from the day the Activity record began, the 7-day share, what is left out and what is said. Pure: no DOM.
import assert from 'node:assert/strict';
import * as D from '../../coral-go/pkg/frontend/static/analytics_tabs_data.js';

const read = (counts, extra = {}) => ({ days_asked: 10, generated_at: '2026-11-10T09:00:00Z', counts: { days: [], inbox: {}, chat: {}, unknown: {}, apart: {}, teams: [], phone: { phone: 0, other: 0 }, record_since: '', note: 'N', ...counts }, ...extra });

// no record yet: nothing to compare, and the words say so
let m = D.inboxModel(read({}));
assert.equal(m.hasRecord, false); assert.equal(m.days.length, 0); assert.equal(m.share, null);
assert.match(D.inboxTrendWords(m), /has not begun/);

// the grid starts the day the record began, and days with no action are there (a gap in the share, not a zero)
m = D.inboxModel(read({ record_since: '2026-11-06', days: [{ day: '2026-11-06', inbox: 1, chat: 9, unknown: 0 }, { day: '2026-11-08', inbox: 5, chat: 5, unknown: 2 }, { day: '2026-11-10', inbox: 9, chat: 1, unknown: 0 }] }));
assert.deepEqual(m.days.map(d => d.day), ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'], 'from the day the record began, to today, every day');
assert.equal(m.days[1].share, null, 'a day with neither side has no share');
assert.equal(m.days[0].roll, 0.1, '1 of 10');
assert.equal(m.days[2].roll, 6 / 20, 'the 7-day share runs over the days there are: 6 inbox of 20');
assert.equal(m.days[4].roll, 15 / 30);
assert.equal(m.last.day, '2026-11-10'); assert.equal(m.first.day, '2026-11-06');
assert.ok(m.last.roll > m.first.roll, 'a share that climbs is a higher number');
// the chart is one point a day (#12991): the day's own share, a gap for a day with no action
assert.deepEqual(m.days.map(d => d.share), [0.1, null, 0.5, null, 0.9], 'the points are each day\'s own share, not the 7-day one');
assert.deepEqual(m.points.map(p => p.value), [0.1, null, 0.5, null, 0.9]);
assert.deepEqual(m.points.map(p => p.label), ['Nov 6', 'Nov 7', 'Nov 8', 'Nov 9', 'Nov 10']);
assert.equal(m.lastDay.day, '2026-11-10'); assert.equal(m.firstDay.day, '2026-11-06');
assert.equal(D.inboxDayWords(m.days[0]), 'Nov 6: 10% in the Inbox (1 of 10 actions)');
assert.equal(D.inboxDayWords(m.days[1]), 'Nov 7: no actions');
assert.equal(D.inboxDayWords(m.days[4]), 'Nov 10: 90% in the Inbox (9 of 10 actions)');
assert.equal(D.inboxDayWords(D.inboxModel(read({ record_since: '2026-11-10', days: [{ day: '2026-11-10', inbox: 1, chat: 0 }] })).days[0]), 'Nov 10: 100% in the Inbox (1 of 1 action)');
assert.equal(m.inbox, 15); assert.equal(m.chat, 15); assert.equal(m.unknown, 2, 'answers with no side are counted apart and are not in either side');
assert.equal(m.share, 0.5);
assert.match(D.inboxTrendWords(m), /^90% of your actions on Nov 10 were in the Inbox, against 10% on Nov 6\. Higher is more in the Inbox\.$/);

// a window of one day is said without a comparison
assert.match(D.inboxTrendWords(D.inboxModel(read({ record_since: '2026-11-10', days: [{ day: '2026-11-10', inbox: 1, chat: 1 }] }))), /^50% of your actions on Nov 10 were in the Inbox\.$/);

// kinds, busiest first, in words; teams with their share; where the Inbox's actions were taken; what is apart
m = D.inboxModel(read({ record_since: '2026-11-01', days: [], inbox: { approve: 4, comment: 2, answer_prompt: 1 }, chat: { typed: 9, answer_prompt: 3 }, teams: [{ team: 'alpha', inbox: 6, chat: 6 }, { team: 'beta', inbox: 1, chat: 0 }], phone: { phone: 1, other: 3 }, apart: { wake: 2, stop: 0 } }));
assert.deepEqual(m.kinds.map(k => [k.name, k.inbox, k.chat]), [['Typed to an agent', 0, 9], ['Answered a question, plan or permission', 1, 3], ['Approved', 4, 0], ['Commented on a file or a goal', 2, 0]]);
assert.deepEqual(m.teams.map(t => [t.team, t.share]), [['alpha', 0.5], ['beta', 1]]);
assert.deepEqual(m.phoneShare, { phone: 1, other: 3, share: 0.25 });
assert.deepEqual(m.apart, [{ key: 'wake', n: 2 }], 'a kind with none is not listed');
assert.equal(D.shareWords(null), 'no actions'); assert.equal(D.shareWords(0.456), '46%');

// a kind the page does not know is shown as it is, and a malformed read does not throw
assert.equal(D.inboxModel(read({ record_since: '2026-11-01', inbox: { brand_new: 2 } })).kinds[0].name, 'brand_new');
assert.doesNotThrow(() => D.inboxModel(null));
assert.doesNotThrow(() => D.inboxModel({}));
console.log('PASS inbox_vs_chat_model: the grid, the 7-day share, the kinds, the teams, the unknowns');
