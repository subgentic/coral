import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
const { liveAgentOf } = await importUi('agent_live');
const agent = (server, board, id) => ({ server, board_project: board, session_id: id, name: id, agent_type: 'claude', display_name: 'Lead Developer', board_subscriber_id: 'Lead Developer', working_directory: '/work/' + id });
const rows = [agent('local', 'dev', 'local-dev'), agent('m1', 'other', 'm1-other'), agent('m2', 'dev', 'm2-dev'), agent('m1', 'dev', 'm1-dev')];
test('role lookup retains both computer and board', () => {
    state.liveSessions = rows;
    assert.equal(liveAgentOf('lead developer', { board: '@m1/dev' }), rows[3]);
    assert.equal(liveAgentOf('Lead Developer', { board: '@m2/dev' }), rows[2]);
    assert.equal(liveAgentOf('Lead Developer', { board: 'dev' }), rows[0]);
    assert.equal(liveAgentOf('Lead Developer', { board: '@m3/dev' }), null);
});
test('a session hint cannot override an explicit team identity', () => {
    state.liveSessions = rows;
    assert.equal(liveAgentOf('Lead Developer', { board: '@m1/dev', session: 'local-dev' }), rows[3]);
});
test('export reads the chosen board agent chat rather than a same-role agent on another board or computer', async () => {
    const { connectBoard, doExportBoard } = await importUi('board_export');
    const host = document.createElement('div'); host.innerHTML = '<div id="mb-export-actions"></div><select id="export-format-select"><option value="json">JSON</option></select><input type="checkbox" checked class="export-agent-cb" value="lead" data-role="Lead Developer">'; document.body.append(host);
    const calls = [];
    globalThis.fetch = window.fetch = async url => {
        const p = String(url); calls.push(p);
        if (p === '/api/sessions/live') return Response.json({ sessions: rows });
        if (p.endsWith('/subscribers')) return Response.json([]);
        return Response.json({ messages: [], before_count: 0 });
    };
    URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = () => {};
    try {
        connectBoard({ project: () => '@m1/dev' }); await doExportBoard();
        const chat = calls.find(p => p.includes('/chat?'));
        assert.ok(chat, 'export reaches the live chat');
        assert.equal(new URL(chat, location.href).pathname, '/api/remote/m1/api/sessions/live/m1-dev/chat');
        assert.equal(new URL(chat, location.href).searchParams.get('session_id'), 'm1-dev');
    } finally { HTMLAnchorElement.prototype.click = click; host.remove(); }
});
test('task assignee link uses its team and never falls back to an unrelated standalone agent', async () => {
    const { registerBundled } = await importUi('import_once');
    registerBundled({ 'team_task_actions.js': { taskButtons: () => [] } });
    const { renderTaskPage } = await importUi('team_tasks_page');
    const host = document.createElement('div'); document.body.append(host);
    let selected;
    window.selectLiveSession = (...args) => { selected = args; };
    state.liveSessions = [{ ...rows[0], board_project: '' }, ...rows.slice(1)];
    const task = { id: 5, title: 'Work', status: 'in_progress', assigned_to: 'Lead Developer' };
    renderTaskPage(host, task, { project: '@m1/dev', onBack() {} });
    const link = host.querySelector('dl.facts dd button'); assert.ok(link, 'own team assignee is linked'); link.click();
    assert.deepEqual(selected, ['m1-dev', 'claude', 'm1-dev', 'm1']);
    renderTaskPage(host, { ...task, session_id: 'local-dev' }, { project: '@m1/dev', onBack() {} });
    host.querySelector('dl.facts dd button').click();
    assert.equal(selected[3], 'm1', 'a foreign session hint cannot redirect the task link');
    state.liveSessions = [{ ...rows[0], board_project: '' }, rows[1], rows[2]];
    renderTaskPage(host, task, { project: '@m1/dev', onBack() {} });
    assert.equal(host.querySelector('dl.facts dd button'), null, 'unrelated agents do not become the assignee link');
    host.remove();
});
test('remote comment Sent to names retain their panel computer', async () => {
    state.liveSessions = rows;
    const { createAsk } = await importUi('artifact_comment_ask');
    const panel = document.createElement('div'), status = document.createElement('p');
    const st = { board: 'dev', server: 'm1', data: { comments: [{ id: 1, asks: [{ agent: 'Lead Developer', open: true, replies: 0 }] }] } };
    const ask = createAsk({ st, panel, render() {}, announce() {}, refresh() {} });
    ask.fillStatus(status, 1);
    assert.equal(status.querySelector('[data-agent-link]')?.dataset.agentLink, 'm1-dev');
});
