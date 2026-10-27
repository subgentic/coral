// The artifacts of a task on its page (#7739): the section lists what the team's Artifacts list holds for this task (the files an agent uploaded while it worked on it and the ones on its result), one line each:
// the name, then type, size, when and who; the name opens the artifact; names are text, never markup; with nothing to show, or a list that cannot be read, there is no section and no error; a name is a 44 px
// target on a phone. A real board on the isolated dev server (a task taken through the real routes, removed again); only the artifacts read is stubbed. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const BASE = require('./test_base').BASE;
const HEX = 'b'.repeat(64);
const STUB = `(() => { const real = window.fetch; window.__reqs = []; window.__artifacts = null;
    window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin); window.__reqs.push(url.pathname + url.search);
        if (/\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && url.searchParams.has('task')) {
            if (window.__artifacts === 'refused') return Promise.resolve(new Response(JSON.stringify({ error: 'owner only' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
            return Promise.resolve(new Response(JSON.stringify(window.__artifacts || { artifacts: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        return real(u, o); }; return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'taskart-' + Date.now().toString(36);
    const open = async (reply, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile: !!mobile });
        await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__artifacts = ${JSON.stringify(reply)}; true`);
        await openBoardTasksTab({ ev, waitFor }, B);
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header)').length === 1`, 'the task', 12000);
        await ev(`document.querySelector('#agentic-panel-tasks .board-task-item:not(.board-task-header)').click(); true`);
        await waitFor(`!!document.querySelector('#preview-pane #team-task-title') && /Write the report/.test(document.querySelector('#team-task-title').textContent)`, 'the task page', 12000);
    };
    const evil = '<img src=x onerror="window.__pwned=1"> report.md';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const made = await api('POST', `/api/board/${B}/tasks`, { title: 'Write the report', body: 'Details', assigned_to: 'be', created_by: 'orch', priority: 'high' });
        assert.ok(made.status < 300, JSON.stringify(made)); const id = made.body.id;

        console.log('a task with artifacts: the section, one line each, the name as text');
        await open({ total: 2, artifacts: [
            { id: HEX, name: evil, media_type: 'text/markdown', size: 1300, created_at: new Date(Date.now() - 3600e3).toISOString(), task_id: id, produced_by: 'Backend Dev', uri: 'coral://artifacts/' + HEX, source: 'upload', available: true },
            { id: 'task-1', name: 'result.txt', media_type: 'text/plain', size: 12, created_at: new Date().toISOString(), task_id: id, source: 'completion', inline: true, content_url: '/api/board/x/tasks/1/artifact-content?source=completion&index=0' }] });
        await waitFor(`!!document.querySelector('#preview-pane .team-task-artifacts')`, 'the section', 8000);
        const d = await ev(`(() => { const s = document.querySelector('#preview-pane .team-task-artifacts'); return { head: s.querySelector('h3').textContent, lines: [...s.querySelectorAll('tbody .dt-row')].map(li => ({ name: li.querySelector('.dt-primary').textContent, tag: li.querySelector('.dt-primary').tagName, meta: li.querySelector('[data-key=type]').textContent + ' · ' + li.querySelector('[data-key=size]').textContent })), imgs: s.querySelectorAll('img').length, pwned: !!window.__pwned, asked: window.__reqs.filter(r => /\\/artifacts\\?/.test(r)) }; })()`);
        assert.equal(d.head, 'Artifacts'); assert.equal(d.lines.length, 2, JSON.stringify(d));
        const first = d.lines.find(row => row.name === evil); assert.ok(first, 'the name is text'); assert.equal(d.imgs, 0, 'and is never markup'); assert.equal(d.pwned, false);
        assert.equal(first.meta, 'Markdown · 1.3 KB');
        assert.equal(d.lines[0].tag, 'BUTTON'); assert.match(d.asked.join(), new RegExp(`task=${id}`), 'it asks for this task\'s artifacts only');
        await ev(`[...document.querySelectorAll('#preview-pane .team-task-artifacts .dt-primary')].find(b => b.textContent === ${JSON.stringify(evil)}).click(); true`);
        await waitFor(`window.__reqs.some(r => r.includes('/api/artifacts/${HEX}'))`, 'the stored artifact is opened (the viewer reads it)', 8000);

        console.log('a phone: the name is a 44 px target');
        await open({ total: 1, artifacts: [{ id: HEX, name: 'report.md', media_type: 'text/markdown', size: 10, created_at: new Date().toISOString(), task_id: id, uri: 'coral://artifacts/' + HEX }] }, true);
        await waitFor(`!!document.querySelector('#preview-pane .dt-primary')`, 'the section on a phone', 8000);
        assert.ok(await ev(`document.querySelector('#preview-pane .dt-primary').getBoundingClientRect().height >= 44`), 'a 44 px target');
        assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, 'nothing runs sideways');

        console.log('nothing to show, or a list that cannot be read: no section, no error');
        for (const reply of [{ total: 0, artifacts: [] }, 'refused']) {
            await open(reply, false);
            await waitFor(`window.__reqs.some(r => /\\/artifacts\\?.*task=/.test(r))`, 'the read', 8000);
            await waitFor(`!!document.querySelector('#preview-pane .team-task-actions, #preview-pane .goals-detail-line, #preview-pane #team-task-title')`, 'the page is up', 4000);
            assert.equal(await ev(`document.querySelectorAll('#preview-pane .team-task-artifacts').length`), 0, JSON.stringify(reply));
            assert.equal(await ev(`document.querySelectorAll('.toast.error').length`), 0, 'no error toast');
        }
        console.log('PASS task_artifacts_section');
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
