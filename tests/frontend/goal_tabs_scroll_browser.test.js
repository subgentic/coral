// #11646 (the operator): on a goal's page, switching between the Tasks and Artifacts tabs jumped the page to the top. The page is drawn again for a tab, and the scrolled box was a new one. The person's place is kept: the tab strip
// stays where it was on screen (a shorter panel may shrink the page, and then the page is at its end, never at the top). At 1280 px (the goal's own column scrolls) and 390 px (the page scrolls). Real board and goal on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gts-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    // the box that scrolls the goal page: the goal's own column when it scrolls (a wide window), else the nearest scrolling ancestor, else the document
    const SCROLLER = `(() => { for (let e = document.querySelector('#team-panel-goals .goal-main'); e; e = e.parentElement) { if (e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== 'visible' && getComputedStyle(e).overflowY !== 'hidden') return e; } return document.scrollingElement; })()`;
    const state = () => ev(`(() => { const s = ${SCROLLER}; const t = document.querySelector('#team-panel-goals .goal-tabs'); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, strip: Math.round(t.getBoundingClientRect().top) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await load('/');
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Keep my place', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        for (let i = 0; i < 30; i++) assert.ok((await api('POST', `/api/board/${B}/tasks`, { title: `Pending task ${i}`, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: G })).status < 300);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: 'Makes the files', body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: G }); assert.ok(t.status < 300, JSON.stringify(t));
        assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: t.body.id })).status < 300);
        const r = await api('POST', `/api/board/${B}/tasks/${t.body.id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: Array.from({ length: 30 }, (_, i) => ({ name: `file-${String(i).padStart(2, '0')}.txt`, content: 'c' + i })) }); assert.ok(r.status < 300, JSON.stringify(r));

        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await load(`/team/${B}/goals/${G}`);
            const at = `${w} px: `;
            await waitFor(`document.querySelector('#team-panel-goals #goal-tab-artifacts .goal-tab-count')?.textContent.trim() === '30'`, at + 'Artifacts 30', 15000);
            await waitFor(`document.querySelectorAll('#team-panel-goals .goal-list tbody tr, #team-panel-goals .goal-list [data-task-id]').length > 8`, at + 'the tasks drawn', 15000);
            for (const [from, to] of [['tasks', 'artifacts'], ['artifacts', 'tasks']]) {
                if (from === 'artifacts') await waitFor(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length >= 5`, at + 'the files drawn', 15000);
                // scroll so the tab strip sits 120 px below the top of the box, and there is a lot of page under it
                await ev(`(() => { const s = ${SCROLLER}, t = document.querySelector('#team-panel-goals .goal-tabs'); s.scrollTop += t.getBoundingClientRect().top - ${mobile ? 60 : 120} - (s === document.scrollingElement ? 0 : s.getBoundingClientRect().top); return true; })()`);
                await new Promise(res => setTimeout(res, 150)); // sleep-ok: the scroll settles
                const before = await state();
                assert.ok(before.top > 20, at + `${from}: the page is scrolled before the click (${JSON.stringify(before)})`);
                await ev(`document.querySelector('#team-panel-goals #goal-tab-${to}').click(); true`);
                await waitFor(`document.querySelector('#team-panel-goals #goal-tab-${to}').getAttribute('aria-selected') === 'true'`, at + `on ${to}`, 8000);
                await new Promise(res => setTimeout(res, 300)); // sleep-ok: the panel draws and the list mounts
                const after = await state();
                assert.ok(after.top > 0 || after.max === 0, at + `${from} to ${to}: the page did not jump to the top (${JSON.stringify({ before, after })})`); // a panel that leaves nothing to scroll (the Artifacts list is 5 of 30 rows on a phone, and the page, now without its pinned bar, fits the screen) is at its end at 0 (#11823)
                const clamped = after.top >= after.max - 2; // a shorter panel shrank the page: it is at its end
                assert.ok(clamped || Math.abs(after.strip - before.strip) <= 2, at + `${from} to ${to}: the tab strip stays where it was on screen (${JSON.stringify({ before, after })})`);
            }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a goal page keeps its scroll position when its tab changes');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
