// #8411: the Inbox Tasks folder uses the shared Tasks toolbar, once, with person-scoped controls.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local', boot: { testHooks: true } }); localStorage.setItem('coral-test-tasks-tab', '1'); // the Inbox's Tasks tab is out for now; a dev build with test hooks shows it again for this check of the kept folder (#22109)
const inbox = await importUi('inbox_sidebar');
await inbox.openInboxGroup('tasks');
const host = document.getElementById('group-table-view');
assert.ok(host.querySelector('.list-bar-bar'), 'Inbox Tasks mounts tasksToolbar, including its Filters panel');
assert.equal(host.querySelectorAll('input[type="search"]').length, 1, 'one page search');
assert.ok(host.querySelector('.list-bar-toggle'), 'shared Filters control');
assert.equal(host.querySelector('[data-on-click="task-create-show"]'), null, 'no team context for creating a task');
assert.equal(host.querySelector('[id$="assignee"]'), null, 'every task belongs to the person');
inbox.filterInbox('release');
await new Promise(resolve => setImmediate(resolve));
assert.equal(host.querySelector('input[type="search"]').value, 'release', 'mailbox search updates shared search');
await inbox.openInboxGroup('needs');
assert.equal(host.querySelector('[id^="inbox-tk-"]'), null, 'Tasks controls do not leak into Needs you');
assert.ok(host.querySelector('.inbox-folder-toolbar .list-bar-toggle'), 'Needs you has its own toolbar with its own Filters (#8604)');
assert.equal(host.querySelectorAll('input[type="search"]').length, 1, 'and one page search');
await inbox.openInboxGroup('tasks');
assert.equal(host.querySelector('input[type="search"]').value, '', 'the search belongs to the folder it was typed in: coming back to Tasks does not find the words of Needs you (#17020)');
inbox.filterInbox('');
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
const previousFetch = globalThis.fetch;
globalThis.fetch = window.fetch = async url => {
    const u = new URL(String(url), 'http://local');
    if (u.pathname !== '/api/board/tasks') return previousFetch(url);
    const p = u.searchParams, states = p.getAll('status');
    const tasks = [
        { id: 1, board_id: 'a', title: 'Release app', priority: 'high', status: 'in_progress', updated_at: '2026-10-25T12:00:00Z' },
        { id: 2, board_id: 'b', title: 'Write notes', priority: 'low', status: 'pending', updated_at: '2026-10-20T12:00:00Z' },
    ].filter(t => (!p.get('q') || t.title.toLowerCase().includes(p.get('q').toLowerCase())) && (!states.length || states.includes(t.status)) && (!p.get('priority') || p.get('priority') === t.priority) && (!p.get('updated_since') || t.updated_at >= p.get('updated_since')));
    return Response.json({ tasks });
};
document.body.setAttribute('data-nav-tab', 'hub-inbox');
await inbox.showInbox({ folder: 'tasks' });
await new Promise(resolve => setImmediate(resolve));
const rows = () => [...host.querySelectorAll('tbody .dt-primary')].map(n => n.textContent);
assert.deepEqual(rows(), ['Release app', 'Write notes']);
const priority = host.querySelector('#inbox-tk-priority');
priority.value = 'high'; priority.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(rows(), ['Release app'], 'priority filter affects rows');
priority.value = ''; priority.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
host.querySelector('[data-filter="Queued"]').focus();
host.querySelector('[data-filter="Queued"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.activeElement.dataset.filter, 'Queued', 'state choice keeps keyboard focus');
assert.deepEqual(rows(), ['Write notes'], 'shared state pills narrow rows');
host.querySelector('[data-filter="all"]').click();
await new Promise(resolve => setImmediate(resolve));
const from = host.querySelector('#inbox-tk-from');
from.value = '2026-10-24'; from.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(rows(), ['Release app'], 'updated-since filter affects rows');
from.value = ''; from.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
inbox.filterInbox('missing');
await new Promise(resolve => setImmediate(resolve));
assert.match(host.textContent, /No task matches the filters/);
assert.ok(host.querySelector('.list-bar-toggle'), 'filters remain reachable with zero results');
inbox.filterInbox('');
await new Promise(resolve => setImmediate(resolve));
assert.equal(rows().length, 2, 'clearing search restores rows');
console.log('inbox_tasks_toolbar: PASS');
process.exit(0); // imported dashboard modules own background timers
