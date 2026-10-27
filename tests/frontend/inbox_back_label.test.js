// The Back link of an Inbox task or goal screen says where it goes (#8861, UI/UX): the title of the goal or task it was opened from (cut with an ellipsis), else the name of the folder or board before it.
//   node inbox_back_label.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
    const m = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/inbox_back_label.js')).href);
    const short = m.shortLabel;
    assert.equal(short('Ship it'), 'Ship it'); assert.equal(short('x'.repeat(30)), 'x'.repeat(23) + '…'); assert.equal(short('  a   b '), 'a b'); assert.equal(short(''), '');
    // no previous screen known (a reload or a deep link): the folder's own word
    assert.equal(m.backLabelFor('task', '', ''), 'Tasks'); assert.equal(m.backLabelFor('goal', '', ''), 'Goals');
    // the folders
    assert.equal(m.backLabelFor('task', '/inbox/tasks', ''), 'Tasks');
    assert.equal(m.backLabelFor('task', '/inbox/needs', ''), 'Needs you');
    assert.equal(m.backLabelFor('task', '/inbox/artifacts', ''), 'Artifacts');
    assert.equal(m.backLabelFor('task', '/inbox/boards/alpha', ''), 'Board history');
    assert.equal(m.backLabelFor('goal', '/inbox/goals', ''), 'Goals');
    assert.equal(m.backLabelFor('goal', '/inbox/needs', ''), 'Needs you');
    // another goal or task: its title when it was remembered, else the kind
    assert.equal(m.backLabelFor('task', '/inbox/goals/alpha/3', 'Keep this goal in the Inbox'), 'Keep this goal in the I\u2026', 'a long title is cut with an ellipsis');
    assert.equal(m.backLabelFor('task', '/inbox/goals/alpha/3', 'Ship it'), 'Ship it');
    assert.equal(m.backLabelFor('task', '/inbox/goals/alpha/3', 'x'.repeat(40)), 'x'.repeat(23) + '…');
    assert.equal(m.backLabelFor('task', '/inbox/goals/alpha/3', ''), 'Goal');
    assert.equal(m.backLabelFor('goal', '/inbox/tasks/alpha/9', '#9 Open me'), '#9 Open me');
    assert.equal(m.backLabelFor('goal', '/inbox/tasks/@ws1/alpha/9', ''), 'Task');
    assert.equal(m.backLabelFor('task', '/inbox/tasks/alpha/8', ''), 'Task', 'a follow-up chain');
    // an address the Inbox does not know: the default
    assert.equal(m.backLabelFor('task', '/team/alpha/tasks/9', ''), 'Tasks');
    console.log('inbox_back_label: all checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
