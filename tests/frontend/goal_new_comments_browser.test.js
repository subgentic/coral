// #12073 (follow-up of #12026): agents replied in the Operator's comment thread on a goal: the goal's own rows say "New comments": the "Goal looks done" row of Needs you (the same row, not a new item) and the goal's row
// in the Goals list; a goal with no news carries none. The server's rule (what /api/goals says, to whom) is in internal/server/routes; here the page's side, with the goals list stood in at its fetch. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'goal-news-' + Date.now().toString(36), failures = [];
    const T = '#group-table-view';
    const rowOf = text => `[...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(${JSON.stringify(text)}))`;
    const tagOn = text => ev(`(() => { const r = ${rowOf(text)}; return !![...r.querySelectorAll('.dt-tag')].find(t => t.textContent.trim() === 'New comments') || (innerWidth < 500 && /New comments/.test(r.textContent)); })()`); // a phone's Goals row is the mail row: the words lead its second line
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Lead',job_title:'Lead'})}).then(r=>r.status)`), 200);
                await ev(`(() => {
                    const goal = (id, title, news) => ({ id, board_id: '${team}', title, outcome: 'o', done_when: 'done when ' + id, state: 'active', rollup: { done: 1, active: 0, blocked: 0, queued: 0, total: 1 }, updated_at: new Date(Date.now() - id * 60000).toISOString(), ...(news ? { new_comments: news } : {}) });
                    window.__goals = [goal(1, 'Goal with news', 2), goal(2, 'Goal without news', 0)];
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const u = new URL(String(url), location.origin);
                        if (u.pathname === '/api/goals') return json({ goals: window.__goals, has_more: false });
                        return original(url, opts);
                    }; return true;
                })()`);
                await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${rowOf('Goal with news')})&&!!(${rowOf('Goal without news')})`, 'both goals look done in Needs you', 20000);
                assert.ok(await tagOn('Goal with news'), 'the goal looks done row says New comments');
                assert.ok(!(await tagOn('Goal without news')), 'the other has none');
                assert.equal(await ev(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /Goal with news/.test(r.textContent)).length`), 1, 'the same row, not a second item');
                // the Goals list
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('goals')).then(()=>true)`);
                await waitFor(`!!(${rowOf('Goal with news')})&&!!(${rowOf('Goal without news')})`, 'both goals in the Goals list', 20000);
                assert.ok(await tagOn('Goal with news'), 'its row in the Goals list says New comments');
                assert.ok(!(await tagOn('Goal without news')), 'the other has none');
                console.log('PASS goal new comments marker ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
