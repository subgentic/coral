// #8904: a registered computer that is hung (its port still accepting, no answer) must not hold the hub's Inbox on "Loading": every merged read gives each registered computer a time limit,
// shows the reachable computers' rows at once, and names the one that did not answer. This computer is not timed. A stalled remote stub; the timer is the test's own clock.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({mode:'local'});
try {
    const { state } = await importUi('state');
    state.hub = true;
    state.servers = [{id:'local',status:'online'},{id:'box-2',label:'Box Two',status:'online'},{id:'box-3',label:'Box Three',status:'offline'}]; // box-3: the hub already knows it is not answering
    const art = id => ({ id: id.repeat(64), name: id + '.md', media_type: 'text/markdown', size: 1, created_at: new Date().toISOString(), board_id: 'alpha', team: 'alpha', task_id: 1, uri: 'coral://artifacts/' + id.repeat(64), available: true });
    let stalled = true;
    globalThis.fetch = window.fetch = (url, opts = {}) => {
        const path = new URL(url, 'https://hub.example').pathname;
        if (path.startsWith('/api/remote/box-2/') && stalled) return new Promise((_, reject) => { if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
        const remote = path.startsWith('/api/remote/box-2/');
        if (path.endsWith('/api/team-artifacts')) return Promise.resolve(Response.json({ artifacts: [art(remote ? 'b' : 'a')], teams: [], all: 1, total: 1, has_more: false }));
        if (path.endsWith('/api/goals')) return Promise.resolve(Response.json({ goals: [{ id: 1, board_id: 'alpha', title: remote ? 'Remote goal' : 'Local goal', state: 'active', rollup: { total: 1, done: 0 } }] }));
        if (path.endsWith('/api/saved')) return Promise.resolve(Response.json({ items: [], open: 0, done: 0 }));
        return Promise.resolve(Response.json({}));
    };
    const { readInboxArtifacts } = await importUi('inbox_servers');
    const inbox = await importUi('inbox_coral');

    mock.timers.enable({ apis: ['setTimeout'] });
    // Artifacts: this computer's file is listed, Box Two is named as not answering, and nothing waits forever
    const pending = readInboxArtifacts(new URLSearchParams({ limit: '50' }), {});
    await new Promise(r => setImmediate(r));
    mock.timers.tick(8000);
    const d = await pending;
    assert.deepEqual(d.artifacts.map(a => a.name), ['a.md'], 'this computer\'s file is listed at once');
    assert.deepEqual(d.down, [{ server: 'box-2', label: 'Box Two' }, { server: 'box-3', label: 'Box Three' }], 'Box Two (timed out) and Box Three (known offline) are named');
    assert.equal(d.has_more, false, 'a computer that did not answer does not keep Load more on');
    // Goals: the same limit
    const goals = inbox.listInboxGoals(); await new Promise(r => setImmediate(r)); mock.timers.tick(8000);
    assert.deepEqual((await goals).map(g => g.title), ['Local goal'], 'goals: the reachable computer\'s rows, no waiting');
    assert.equal(inbox.inboxDownNote('goals'), 'Box Two, Box Three did not answer, so their goals are not shown.', 'Goals says so, quietly');
    const tasks = inbox.coralInboxAdapter.listTasks(); await new Promise(r => setImmediate(r)); mock.timers.tick(8000); await tasks;
    assert.equal(inbox.inboxDownNote('tasks'), 'Box Two, Box Three did not answer, so their tasks are not shown.', 'Tasks says so, quietly');
    mock.timers.reset();

    // when it answers, both computers' files are listed and nobody is down
    stalled = false;
    const ok = await readInboxArtifacts(new URLSearchParams({ limit: '50' }), {});
    assert.deepEqual(ok.artifacts.map(a => a.name).sort(), ['a.md', 'b.md'], 'both computers\' files');
    assert.deepEqual(ok.down, [{ server: 'box-3', label: 'Box Three' }], 'only the offline one is down');
    await inbox.listInboxGoals(); assert.equal(inbox.inboxDownNote('goals'), 'Box Three did not answer, so its goals are not shown.', 'the line keeps only the offline one when Box Two answers');
    console.log('inbox_server_timeout: ok');
} finally { dom.close && dom.close(); }
