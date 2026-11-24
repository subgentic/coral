// The Cost page's Export CSV (#21021, the approved stage-1 mock #21017): the file's cells, its Total row (the page's Total cost), the guard against a cell a spreadsheet would run, the name, and the chooser (by task or goal, the range said, the download).
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
const x = await importUi('cost_export');

const T = (id, title, cost, extra = {}) => ({ id, title, board_id: 'alpha', status: 'completed', assigned_to: 'Lead Developer', claimed_at: '2026-11-23T09:00:00Z', completed_at: '2026-11-23T10:00:00Z', cost_usd: cost, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, ...extra });
const parse = csv => csv.trimEnd().split('\r\n');

test('a text cell is quoted when it needs it, and one that starts like a formula is made text', () => {
    assert.equal(x.csvText('plain'), 'plain');
    assert.equal(x.csvText('a, b'), '"a, b"');
    assert.equal(x.csvText('say "hi"'), '"say ""hi"""');
    assert.equal(x.csvText('two\nlines\r\nhere'), 'two lines here');
    for (const bad of ['=SUM(A1)', '+1', '-1+2', '@cmd', '\tx']) assert.equal(x.csvText(bad)[0] === "'" || x.csvText(bad).startsWith('"\''), true, bad);
    assert.equal(x.csvText("=1,2"), '"\'=1,2"');
    assert.equal(x.csvText(null), '');
});

test('a figure stays a number, a negative one too, and a bad one is 0', () => {
    assert.equal(x.csvNumber(1.23456789), '1.234568');
    assert.equal(x.csvNumber(-4.5), '-4.5');
    assert.equal(x.csvNumber(NaN), '0');
    assert.equal(x.csvNumber('3'), '0');
});

test('the task file has a row per task, the rest row and a Total that adds them up', () => {
    const rows = parse(x.taskCsv([T(1, 'First', 1.5), T(2, '=HYPERLINK("x")', 2.25)], { id: 0, untasked: true, title: 'Not on a task', cost_usd: 0.25 }));
    assert.equal(rows[0], x.EXPORT_TASK_HEAD.join(','));
    assert.equal(rows.length, 5);
    assert.equal(rows[1].split(',')[0], 'First');
    assert.ok(rows[2].startsWith('"\'=HYPERLINK(""x"")"'), rows[2]);
    assert.equal(rows[3], 'Not on a task,,,,,,,0.25,0,0,0,0', 'the cost no task carries has no id, team, status, agent or times');
    const total = rows[4].split(',');
    assert.deepEqual([total[0], total[7], total[8], total[9], total[10], total[11]], ['Total', '4', '20', '40', '60', '80']);
});

test('the goal file has the rows of the table and a Total', () => {
    const rows = parse(x.goalCsv([{ id: 7, title: 'Goal, seven', tasks: 2, cost_usd: 3.5, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 }, { id: 0, title: 'Tasks with no goal', tasks: 1, cost_usd: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, { id: -1, untasked: true, title: 'Not on a task', tasks: 0, cost_usd: -0.5 }]));
    assert.equal(rows[0], x.EXPORT_GOAL_HEAD.join(','));
    assert.equal(rows[1], '"Goal, seven",7,2,3.5,1,2,3,4');
    assert.equal(rows[2], 'Tasks with no goal,,1,1,0,0,0,0');
    assert.equal(rows[3], 'Not on a task,,0,-0.5,0,0,0,0');
    assert.equal(rows[4], 'Total,,3,4,1,2,3,4');
});

test('an empty range is a header and a zero Total, never a broken file', () => {
    assert.deepEqual(parse(x.taskCsv([], null)), [x.EXPORT_TASK_HEAD.join(','), 'Total,,,,,,,0,0,0,0,0']);
    assert.deepEqual(parse(x.goalCsv([])), [x.EXPORT_GOAL_HEAD.join(','), 'Total,,0,0,0,0,0,0']);
});

test('the file name says what it is by, the range, the team and the day', () => {
    const d = new Date(2026, 10, 24, 12);
    assert.equal(x.exportName('task', 'week', '', d), 'coral-cost-by-task-week-2026-11-24.csv');
    assert.equal(x.exportName('goal', 'day', 'a b/c', d), 'coral-cost-by-goal-day-a_b_c-2026-11-24.csv');
});

test('the chooser says the range and downloads the choice', () => {
    let got = null;
    const urls = []; dom.window.URL.createObjectURL = b => { urls.push(b); return 'blob:x'; }; dom.window.URL.revokeObjectURL = () => {};
    globalThis.URL.createObjectURL = dom.window.URL.createObjectURL; globalThis.URL.revokeObjectURL = () => {};
    const clicks = []; dom.window.HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
    x.openExportDialog({ period: 'week', team: '', model: by => { got = by; return { csv: 'a,b\r\n' }; } });
    const modal = document.getElementById('cost-export-modal');
    assert.ok(modal);
    assert.equal(modal.querySelector('h3').textContent, 'Export cost as CSV');
    assert.match(modal.textContent, /By task/); assert.match(modal.textContent, /By goal/);
    assert.match(modal.querySelector('.cost-export-note').textContent, /The range above: the last 7 days\. Totals match this page\./);
    modal.querySelector('input[value="goal"]').click();
    [...modal.querySelectorAll('button')].find(b => b.textContent === 'Download CSV').click();
    assert.equal(got, 'goal');
    assert.equal(clicks.length, 1); assert.match(clicks[0], /^coral-cost-by-goal-week-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.equal(document.getElementById('cost-export-modal'), null, 'the chooser closes');
    x.openExportDialog({ period: 'day', team: 'alpha', model: () => ({ csv: '' }) });
    assert.match(document.querySelector('.cost-export-note').textContent, /team alpha: that team's tasks/);
    [...document.querySelectorAll('#cost-export-modal button')].find(b => b.textContent === 'Cancel').click();
    assert.equal(document.getElementById('cost-export-modal'), null);
});
