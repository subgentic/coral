// A reminder's Custom (cron) line (#21330): the dialog checks it by the server's rules (store.CronLine), says it in words and says when it next fires. node reminder_cron.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const { checkCron, nextRun } = await importUi('reminder_cron');
const { scheduleWords } = await importUi('chief_checks_model');

// the same lines the Go test takes (internal/store/chief_cron_line_test.go)
for (const [line, want] of [['0 9 * * 1-5', '0 9 * * 1-5'], ['  */5   *  * * *  ', '*/5 * * * *'], ['0,30 8-17 * * *', '0,30 8-17 * * *'], ['15 10 1 */2 *', '15 10 1 */2 *'], ['0 0 29 2 *', '0 0 29 2 *'], ['*/15 * * * *', '*/15 * * * *'], ['59,4 23,0 * * *', '59,4 23,0 * * *']]) {
    const c = checkCron(line); assert.ok(c.ok, `${line}: ${c.error}`); assert.equal(c.line, want);
}
for (const [line, why] of [['', /Write a cron line/], ['   ', /Write a cron line/], ['@reboot', /@words/], ['@daily', /@words/], ['0 0 9 * * 1-5', /exactly 5 fields/], ['0 9 * *', /exactly 5 fields/], ['0 9 * * MON', /no names/], ['0 9 * JAN *', /no names/], ['0 9 ? * *', /no names/],
    ['0 9 L * *', /no names/], ['0 9 * * 1#2', /no names/], ['60 9 * * *', /minute runs from 0 to 59/], ['0 24 * * *', /hour runs from 0 to 23/], ['0 9 32 * *', /day of the month runs from 1 to 31/], ['0 9 * 13 *', /month runs from 1 to 12/],
    ['0 9 * * 7', /weekday runs from 0 to 6/], ['*/0 * * * *', /step/], ['5-1 * * * *', /backwards/], ['CRON_TZ=UTC 0 9 * * *', /exactly 5 fields/], ['1,'.repeat(80) + '2 * * * *', /too long/],
    ['* * * * *', /at most every 5 minutes/], ['*/1 * * * *', /every 1 minute at times/], ['*/2 * * * *', /every 2 minutes at times/], ['*/4 * * * *', /at most every 5 minutes/], ['0,3 * * * *', /every 3 minutes/], ['0-10 9 * * *', /at most every 5 minutes/], ['0,1 0 29 2 *', /every 1 minute/]]) {
    const c = checkCron(line); assert.equal(c.ok, false, `${line} passed`); assert.match(c.error, why, line); assert.ok(!/\n/.test(c.error), 'one line');
}

// when it next fires, in the person's own zone: a weekday morning line asked on a Friday after nine is the Monday
const fri = new Date(2026, 10, 20, 10, 0, 0); // Fri 2026-11-20 10:00 local
const next = nextRun('0 9 * * 1-5', fri); assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()], [2026, 10, 23, 9, 0]);
const soon = nextRun('*/5 * * * *', new Date(2026, 10, 20, 10, 2, 0)); assert.equal(soon.getMinutes(), 5);
assert.equal(nextRun('0 9 * * 1-5', new Date(2026, 10, 20, 8, 59, 0)).getDate(), 20, 'before nine the same day');
const both = nextRun('0 9 13 * 5', new Date(2026, 10, 20, 10, 0, 0)); assert.equal(both.getDate(), 27, 'day 13 or a Friday: the next Friday'); // cron: both restricted means either
assert.equal(nextRun('* * * * *', fri), null, 'a refused line has no next run');
assert.equal(nextRun('0 0 29 2 *', new Date(2026, 0, 1)).getFullYear(), 2028);

// the list says a cron reminder in words (the line is the tooltip, where it is drawn)
assert.match(scheduleWords({ schedule_kind: 'cron', at: '0 9 * * 1-5', timezone: 'Europe/Berlin' }), /^Weekdays at .+ · Europe\/Berlin$/);
console.log('PASS reminder_cron');
