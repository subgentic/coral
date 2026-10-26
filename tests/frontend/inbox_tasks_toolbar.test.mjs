// #8411: the Inbox Tasks folder uses the shared Tasks toolbar, once, with person-scoped controls.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const inbox = await importUi('inbox_sidebar');
await inbox.openInboxGroup('tasks');
const host = document.getElementById('group-table-view');
assert.ok(host.querySelector('.list-bar-bar'), 'Inbox Tasks mounts tasksToolbar, including its Filters panel');
assert.equal(host.querySelectorAll('input[type="search"]').length, 1, 'one page search');
assert.ok(host.querySelector('.list-bar-toggle'), 'shared Filters control');
assert.equal(host.querySelector('[data-on-click="task-create-show"]'), null, 'no team context for creating a task');
assert.equal(host.querySelector('[id$="assignee"]'), null, 'every task belongs to the person');
inbox.filterInbox('release');
assert.equal(host.querySelector('input[type="search"]').value, 'release', 'mailbox search updates shared search');
await inbox.openInboxGroup('needs');
assert.equal(host.querySelector('[id^="inbox-tk-"]'), null, 'Tasks controls do not leak into Needs you');
assert.ok(host.querySelector('.inbox-folder-toolbar .list-bar-toggle'), 'Needs you has its own toolbar with its own Filters (#8604)');
assert.equal(host.querySelectorAll('input[type="search"]').length, 1, 'and one page search');
await inbox.openInboxGroup('tasks');
assert.equal(host.querySelector('input[type="search"]').value, 'release', 'folder retains its search');
inbox.filterInbox('');
const { coralInboxAdapter } = await importUi('inbox_coral');
coralInboxAdapter.listTasks = async () => [
    { id: 1, project: 'a', title: 'Release app', priority: 'high', status: 'in_progress', updated_at: '2026-10-25T12:00:00Z' },
    { id: 2, project: 'b', title: 'Write notes', priority: 'low', status: 'pending', updated_at: '2026-10-20T12:00:00Z' },
];
document.body.setAttribute('data-nav-tab', 'hub-inbox');
await inbox.showInbox({ folder: 'tasks' });
const rows = () => [...host.querySelectorAll('tbody .dt-primary')].map(n => n.textContent);
assert.deepEqual(rows(), ['Release app', 'Write notes']);
const priority = host.querySelector('#inbox-tk-priority');
priority.value = 'high'; priority.dispatchEvent(new Event('change', { bubbles: true }));
assert.deepEqual(rows(), ['Release app'], 'priority filter affects rows');
priority.value = ''; priority.dispatchEvent(new Event('change', { bubbles: true }));
host.querySelector('[data-filter="Queued"]').focus();
host.querySelector('[data-filter="Queued"]').click();
assert.equal(document.activeElement.dataset.filter, 'Queued', 'state choice keeps keyboard focus');
assert.deepEqual(rows(), ['Write notes'], 'shared state pills narrow rows');
host.querySelector('[data-filter="all"]').click();
const from = host.querySelector('#inbox-tk-from');
from.value = '2026-10-24'; from.dispatchEvent(new Event('change', { bubbles: true }));
assert.deepEqual(rows(), ['Release app'], 'updated-since filter affects rows');
from.value = ''; from.dispatchEvent(new Event('change', { bubbles: true }));
inbox.filterInbox('missing');
assert.match(host.textContent, /No task matches the filters/);
assert.ok(host.querySelector('.list-bar-toggle'), 'filters remain reachable with zero results');
inbox.filterInbox('');
assert.equal(rows().length, 2, 'clearing search restores rows');
console.log('inbox_tasks_toolbar: PASS');
process.exit(0); // imported dashboard modules own background timers
