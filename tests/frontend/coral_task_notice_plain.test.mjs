// A task notice is shown in plain words, with the stored task's title (#16853, walk 35 F2): the chat showed "run 'coral-board task claim 4' to start" and the title as it was when the notice was delivered, which
// differed from the Tasks tab once the task was edited.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { plainTaskNotice, appendCoralNotice } = await importUi('pending_messages');
const { state } = await importUi('state');

const stored = { 4: 'Quiz page, final wording' };
const titleOf = id => stored[id] || '';
const cases = [
    ["@Developer [Task #4 (high)] Quiz page — assigned to you, run 'coral-board task claim 4' to start", 'Task #4 was assigned to you: Quiz page, final wording'],
    ["[Task #4 reassigned to you] Quiz page — run 'coral-board task claim 4' to start", 'Task #4 was reassigned to you: Quiz page, final wording'],
    ["@notify-all [New Task #4 (medium)] Quiz page — run 'coral-board task claim' to pick it up", 'New task #4 is open to claim: Quiz page, final wording'],
    ["@notify-all [Task #7 reassigned — now unassigned] Old title — run 'coral-board task claim' to pick it up", 'Task #7 is open to claim again: Old title'], // not stored: the notice's own title
];
for (const [raw, want] of cases) {
    const text = raw.replace(/^@[^@\n\r]+?\s+(?=\[)/, '');
    assert.equal(plainTaskNotice(text, titleOf), want, raw);
    assert.ok(!/coral-board/.test(plainTaskNotice(text, titleOf)), 'no command line is shown');
}
// other notices are left as they came
for (const t of ['[Task #4309 reminder] Still in progress. Continue it.', "You have 2 unread messages on the message board. Run 'coral-board read' to see them.", '[Task #4304 cancelled] Not needed.'])
    assert.equal(plainTaskNotice(t, titleOf), t);
// the pill reads the stored title from the board's list
state.currentBoardTasks = [{ id: 4, title: 'Edited after the notice' }];
const box = document.createElement('div');
appendCoralNotice(box, "[Task #4 (high)] Quiz page — assigned to you, run 'coral-board task claim 4' to start");
assert.equal(box.querySelector('.chat-system-text').textContent, 'Task #4 was assigned to you: Edited after the notice');
console.log('coral_task_notice_plain: ok');
