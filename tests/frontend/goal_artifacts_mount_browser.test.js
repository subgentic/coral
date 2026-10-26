// A goal's Artifacts inside the shared goal view (#8616, Goal #61): below the progress and above the pinned bar, closed with its count (the count in the quiet tone), nothing for a goal with none; open, the files
// grouped by task, and on a phone the first 5 so Load more is on screen without scrolling; a name opens the document. The team page's goal route and the Inbox's, a real board and goal on the isolated dev
// server (removed again).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gm-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const goal = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body.id; };
        const G = await goal('Ship the report'), E = await goal('Nothing yet');
        const t = await api('POST', `/api/board/${B}/tasks`, { title: 'Write it', body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: G }); assert.ok(t.status < 300);
        const id = t.body.id || t.body.task.id;
        assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
        const arts = []; for (let i = 0; i < 7; i++) arts.push({ name: `file-${i}.txt`, content: 'content ' + i });
        arts.unshift({ name: 'report.md', content: '# Report' });
        assert.ok((await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: arts })).status < 300);

        for (const [where, route] of [['team page', g => `/team/${B}/goals/${g}`], ['Inbox', g => `/inbox/goals/${B}/${g}`]]) {
            for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
                const at = `${where} at ${w}px: `;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
                await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
                console.log(`${at}a goal with none has no section`);
                await load(route(E));
                await waitFor(`!!document.getElementById('goals-detail-title') && document.getElementById('goals-detail-title').textContent === 'Nothing yet'`, 'the empty goal', 15000);
                assert.equal(await ev(`[...document.querySelectorAll('.goal-artifacts')].filter(d => !d.hidden).length`), 0, at + 'nothing drawn for none');

                console.log(`${at}closed with the count, between the progress and the pinned bar`);
                await load(route(G));
                await waitFor(`!!document.getElementById('goals-detail-title') && document.getElementById('goals-detail-title').textContent === 'Ship the report'`, 'the goal', 15000);
                await waitFor(`!!document.querySelector('.goal-artifacts:not([hidden]) summary') && document.querySelector('.goal-artifacts summary').textContent === 'Artifacts (8)'`, 'Artifacts (8)', 10000);
                const order = await ev(`(() => { const main = document.querySelector('.goal-main'), kids = [...main.children], a = kids.findIndex(k => k.classList.contains('goal-artifacts-host')), p = kids.findIndex(k => k.classList.contains('goals-progress')), b = kids.findIndex(k => k.classList.contains('goals-pinbar')); return { a, p, b }; })()`);
                assert.ok(order.p < order.a && order.a < order.b, at + 'progress, Artifacts, pinned bar: ' + JSON.stringify(order));
                assert.equal(await ev(`getComputedStyle(document.querySelector('.goal-artifacts-count')).fontWeight`), '400', at + 'the count is quiet');
                assert.equal(await ev(`document.querySelector('.goal-artifacts').open`), false);
                await shot(`goal-artifacts-closed-${where === 'Inbox' ? 'inbox' : 'team'}-${w}`);

                console.log(`${at}open: grouped by task, Load more on screen`);
                await ev(`document.querySelector('.goal-artifacts summary').click(); true`);
                const first = mobile ? 5 : 8;
                await waitFor(`document.querySelectorAll('.goal-artifacts [data-artifact-id]').length === ${first}`, `${first} files`, 10000);
                assert.ok(await ev(`/Write it/.test(document.querySelector('.goal-artifacts tr.dt-group').textContent)`), at + 'the task head');
                if (mobile) {
                    await ev(`document.querySelector('.goal-artifacts').scrollIntoView({ block: 'start' }); true`);
                    const rect = await ev(`(() => { const b = document.querySelector('.goal-artifacts .dt-more'); const r = b.getBoundingClientRect(); return { bottom: r.bottom, h: innerHeight }; })()`);
                    assert.ok(rect.bottom <= rect.h, at + 'Load more is on screen without scrolling the table: ' + JSON.stringify(rect));
                }
                await shot(`goal-artifacts-open-${where === 'Inbox' ? 'inbox' : 'team'}-${w}`);
                if (!mobile && where === 'team page') {
                    console.log(`${at}a name opens the document`);
                    await ev(`[...document.querySelectorAll('.goal-artifacts [data-artifact-id]')].find(b => b.textContent === 'report.md').click(); true`);
                    await waitFor(`[...document.querySelectorAll('button, a')].some(b => b.textContent === 'Copy link')`, 'the detail pane', 10000);
                    await waitFor(`document.body.textContent.includes('Report')`, 'the document', 10000);
                    await shot('goal-artifacts-document-team-1280');
                }
            }
        }
        console.log('The page drawn again keeps the section open; a changed rollup refreshes the count');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        const G2 = await goal('Redraw me');
        const done = async (title, names) => { const t2 = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: G2 }); assert.ok(t2.status < 300); const i2 = t2.body.id || t2.body.task.id;
            assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: i2 })).status < 300);
            assert.ok((await api('POST', `/api/board/${B}/tasks/${i2}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: names.map(n => ({ name: n, content: 'c ' + n })) })).status < 300); };
        await done('First', ['a.txt', 'b.txt', 'c.txt']);
        await load(`/team/${B}/goals/${G2}`);
        await waitFor(`!!document.querySelector('.goal-artifacts:not([hidden]) summary') && document.querySelector('.goal-artifacts summary').textContent === 'Artifacts (3)'`, 'Artifacts (3)', 15000);
        await ev(`document.querySelector('.goal-artifacts summary').click(); true`);
        await waitFor(`document.querySelectorAll('.goal-artifacts [data-artifact-id]').length === 3`, 'three files', 10000);
        // (a) the goal is drawn again (its title changed: the same rollup): the section is the same open one with its rows
        await ev(`window.__sectionBefore = document.querySelector('.goal-artifacts'); true`);
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G2}`, { subscriber_id: 'Operator', title: 'Redrawn goal' })).status, 200);
        await ev(`window.dispatchEvent(new Event('focus')); true`);
        await waitFor(`document.getElementById('goals-detail-title').textContent === 'Redrawn goal'`, 'the goal drawn again', 15000);
        assert.equal(await ev(`document.querySelector('.goal-artifacts') === window.__sectionBefore`), true, 'the same section node, not a new one');
        assert.equal(await ev(`document.querySelector('.goal-artifacts').open`), true, 'still open');
        assert.equal(await ev(`document.querySelectorAll('.goal-artifacts [data-artifact-id]').length`), 3, 'with its rows');
        // (b) the rollup changes (a second task done with two more files): the count and the open list refresh
        await done('Second', ['d.txt', 'e.txt']);
        await ev(`window.dispatchEvent(new Event('focus')); true`);
        await waitFor(`document.querySelector('.goal-artifacts summary').textContent === 'Artifacts (5)'`, 'the count refreshed to 5', 15000);
        await waitFor(`document.querySelectorAll('.goal-artifacts [data-artifact-id]').length === 5`, 'the open list refreshed to 5 files', 15000);
        assert.equal(await ev(`document.querySelector('.goal-artifacts').open`), true, 'still open after the refresh');
        console.log('   ✓');
        console.log('PASS goal artifacts mount: in the goal view on the team page and in the Inbox, closed with a quiet count, grouped by task, Load more on a phone, a name opens the document');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
