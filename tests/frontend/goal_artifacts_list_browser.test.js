// A goal's Artifacts tab keeps what the old disclosure suites held (#8952, carried over from goal_artifacts_browser and goal_artifacts_mount_browser): the shared artifact table (#8931) with the first 20 and Load more (5 on a phone), shows only
// this goal's files, and, on the goal screen, the tab's count and its open list follow the goal's rollup while the list node survives a redraw. Real board and goals on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gal-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const goal = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g)); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body.id; };
        const done = async (title, names, goalId) => {
            const t = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: goalId }); assert.ok(t.status < 300, JSON.stringify(t)); const id = t.body.id || t.body.task.id;
            assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
            const r = await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: names.map(n => ({ name: n, content: 'c ' + n })) }); assert.ok(r.status < 300, JSON.stringify(r)); return id;
        };
        const G = await goal('Ship it');
        await done('Write the report', ['report.md', 'notes.txt'], G);
        await done('Take the screenshots', Array.from({ length: 21 }, (_, i) => `shot-${String(i).padStart(2, '0')}.txt`), G);
        await done('Unrelated', ['other.md'], null);
        await ev(`import(${S} + 'state.js').then(m => { m.state.selectedTeam = ${JSON.stringify(B)}; return true; })`);
        const mount = (id) => ev(`(async () => { const m = await import(${S} + 'goal_artifacts.js'); let h = document.getElementById('ga-host'); if (h) h.remove(); h = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'ga-host' })); window.__counts = []; window.__ga = m.mountGoalArtifactsList(h, { team: ${JSON.stringify(B)}, goalId: ${id}, onCount: n => window.__counts.push(n) }); return true; })()`);

        console.log('1. The list: the first 20, Load more, only this goal\'s files');
        await mount(G);
        await waitFor(`document.querySelectorAll('#ga-host [data-artifact-id]').length === 20`, 'the first 20', 10000);
        assert.equal(await ev(`/Showing 20 of 23/.test(document.getElementById('ga-host').textContent)`), true);
        assert.deepEqual(await ev(`window.__counts.slice(-1)`), [23], 'the count is the whole goal\'s');
        await ev(`document.querySelector('#ga-host .dt-more').click(); true`);
        await waitFor(`document.querySelectorAll('#ga-host [data-artifact-id]').length === 23`, 'all 23', 10000);
        assert.equal(await ev(`document.getElementById('ga-host').textContent.includes('other.md')`), false, 'only this goal\'s files');
        console.log('   ✓');

        console.log('2. A phone shows the first 5');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await mount(G);
        await waitFor(`document.querySelectorAll('#ga-host [data-artifact-id]').length === 5`, 'the first 5', 10000);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        console.log('   ✓');

        console.log('3. On the goal screen: the list node survives a redraw; a changed rollup refreshes the count and the open list');
        const G2 = await goal('Redraw me');
        await done('First', ['a.txt', 'b.txt', 'c.txt'], G2);
        await load(`/team/${B}/goals/${G2}`);
        await waitFor(`document.querySelector('#team-panel-goals #goal-tab-artifacts .goal-tab-count')?.textContent.trim() === '3'`, 'Artifacts 3', 15000);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-artifacts').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length === 3`, 'three files', 10000);
        await ev(`window.__hostBefore = document.querySelector('#team-panel-goals .goal-artifacts-host'); true`);
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G2}`, { subscriber_id: 'Operator', title: 'Redrawn goal' })).status, 200);
        await ev(`window.dispatchEvent(new Event('focus')); true`);
        await waitFor(`document.getElementById('goals-detail-title').textContent === 'Redrawn goal'`, 'the goal drawn again', 15000);
        assert.equal(await ev(`document.querySelector('#team-panel-goals .goal-artifacts-host') === window.__hostBefore`), true, 'the same list node, not a new one');
        assert.equal(await ev(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length`), 3, 'with its rows');
        await done('Second', ['d.txt', 'e.txt'], G2);
        await ev(`window.dispatchEvent(new Event('focus')); true`);
        await waitFor(`document.querySelector('#team-panel-goals #goal-tab-artifacts .goal-tab-count')?.textContent.trim() === '5'`, 'the count refreshed to 5', 15000);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length === 5`, 'the open list refreshed to 5 files', 15000);
        assert.equal(await ev(`document.querySelector('#team-panel-goals #goal-tab-artifacts').getAttribute('aria-selected')`), 'true', 'still on the Artifacts tab');
        console.log('   ✓');
        console.log('PASS goal artifacts list: 20 then Load more, 5 on a phone, only the goal\'s files, the count and the open list follow the rollup');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
