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
    let inflight = 0, maxInflight = 0;
    globalThis.fetch = window.fetch = (url, opts = {}) => {
        const path = new URL(url, 'https://hub.example').pathname;
        if (path.startsWith('/api/remote/box-2/') && stalled) { inflight++; maxInflight = Math.max(maxInflight, inflight); if (opts.signal) opts.signal.addEventListener('abort', () => { inflight--; }); } // box-2 requests on their way
        if (path.startsWith('/api/remote/box-2/') && stalled) return new Promise((_, reject) => { if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
        const remote = path.startsWith('/api/remote/'), three = path.startsWith('/api/remote/box-3/');
        if (path.endsWith('/api/team-artifacts')) return Promise.resolve(Response.json({ artifacts: [art(three ? 'c' : remote ? 'b' : 'a')], teams: [], all: 1, total: 1, has_more: false }));
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
    stalled = false; (await importUi('server_base')).forgetSlowComputers(); // a Retry
    const ok = await readInboxArtifacts(new URLSearchParams({ limit: '50' }), {});
    assert.deepEqual(ok.artifacts.map(a => a.name).sort(), ['a.md', 'b.md'], 'both computers\' files');
    assert.deepEqual(ok.down, [{ server: 'box-3', label: 'Box Three' }], 'only the offline one is down');
    await inbox.listInboxGoals(); assert.equal(inbox.inboxDownNote('goals'), 'Box Three did not answer, so its goals are not shown.', 'the line keeps only the offline one when Box Two answers');
    // A hung computer beside a healthy one (QA Reviewer 2's real check): Box Two has a dozen requests open, Box Three is healthy. At most 2 are on their way to Box Two at once, the rest wait;
    // Box Three's files are listed and only Box Two is named; a request that waited for its turn is not marked "did not answer" until its own clock (started when it was sent) runs out.
    const { serverRead } = await importUi('server_base');
    state.servers = [{id:'local',status:'online'},{id:'box-2',label:'Box Two',status:'online'},{id:'box-3',label:'Box Three',status:'online'}];
    stalled = true; inflight = 0; maxInflight = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    const extra = Array.from({ length: 6 }, (_, i) => serverRead('box-2', '/api/extra' + i).then(() => 'answered', e => e.timedOut ? 'timed out' : 'failed'));
    const three = readInboxArtifacts(new URLSearchParams({ limit: '50' }), {});
    await new Promise(r => setImmediate(r));
    assert.equal(maxInflight, 2, 'at most 2 requests are on their way to Box Two at once');
    mock.timers.tick(8000);
    const t = await three;
    assert.deepEqual(t.artifacts.map(a => a.name).sort(), ['a.md', 'c.md'], 'this computer\'s and Box Three\'s files are listed');
    assert.deepEqual(t.down.map(x => x.server), ['box-2'], 'only Box Two is named, not the healthy Box Three');
    assert.ok(maxInflight <= 2, 'still at most 2 at once after the first two timed out');
    // the computer just ran out its time: the next read is given up on at once (no second wait behind the sidebar's reads), and a Retry forgets it
    await assert.rejects(serverRead('box-2', '/api/late'), e => e.timedOut === true, 'given up on at once, not waited for again');
    const { forgetSlowComputers } = await importUi('server_base');
    forgetSlowComputers(); inflight = 0;
    const again = serverRead('box-2', '/api/again').then(() => 'answered', e => e.timedOut ? 'timed out' : 'failed');
    await new Promise(r => setImmediate(r));
    assert.equal(inflight, 1, 'after Retry the computer is asked again');
    mock.timers.tick(8000);
    assert.equal(await again, 'timed out');
    // a computer that comes back online is read again (#8933): box-2 is slow now (it ran out its time), then the hub's list says a status changed (coral-servers) and the slow state is forgotten, so the next read is asked, not given up on
    await assert.rejects(serverRead('box-2', '/api/still'), e => e.timedOut === true, 'still slow: given up on at once');
    const { updateServersTabVisibility: statusChanged } = await importUi('servers_tab');
    state.servers = [{ id: 'box-2', label: 'Box Two', status: 'offline' }]; statusChanged(); // a status changed: coral-servers fires (the hub's list moved on)
    inflight = 0;
    const back = serverRead('box-2', '/api/back').then(() => 'answered', e => e.timedOut ? 'timed out' : 'failed');
    await new Promise(r => setImmediate(r));
    assert.equal(inflight, 1, 'after its status changed the computer is asked again');
    mock.timers.tick(8000);
    assert.equal(await back, 'timed out');
    mock.timers.tick(8000); mock.timers.tick(8000);
    assert.ok((await Promise.all(extra)).every(r => r === 'timed out'), 'every Box Two request ends as "did not answer", none hangs');
    mock.timers.reset();
    // a fresh load: the lists were read before the hub's computers were known; when the list arrives (or a status changes) the Inbox is told once, and not for the same list again (#8922)
    const { updateServersTabVisibility } = await importUi('servers_tab');
    let told = 0; document.addEventListener('coral-servers', () => told++);
    state.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }]; updateServersTabVisibility(); updateServersTabVisibility();
    assert.equal(told, 1, 'told once for a new list, not again for the same one');
    state.servers = [{ id: 'box-2', label: 'Box Two', status: 'unreachable' }]; updateServersTabVisibility();
    assert.equal(told, 2, 'and again when a status changes');
    console.log('inbox_server_timeout: ok');
} finally { dom.close && dom.close(); }
