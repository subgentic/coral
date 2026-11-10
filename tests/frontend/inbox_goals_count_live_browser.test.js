// #15229 (walk 10 L17): after the only goal was closed the sidebar still said 'Goals 1' (it caught up with its own poll, ~25 s). The goals change counter that every goal write moves (/ws/coral, goals_brief) now
// makes the Inbox read its goals at once: a goal closed from anywhere (its page, another browser, an agent) leaves the Goals count within seconds. Real server, one team, one goal; the runner's page has no live
// /ws/coral, so the frame's goals_brief is published through goals_feed.publishGoalsBrief, which is what the socket's handler calls (websocket.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { FOLDER_ROWS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'goal-count-' + Date.now().toString(36);
    const post = (path, body) => ev(`fetch(${JSON.stringify('/api/board/' + team + path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json())`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await post('/subscribe', { subscriber_id: 'Dev', job_title: 'Dev' });
        const made = await post('/goals', { title: 'The only goal', outcome: 'x', done_when: 'y', subscriber_id: 'Operator' });
        assert.ok(made && made.id, 'the goal was made: ' + JSON.stringify(made));
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Goals1$/.test(w))`, 'Goals counts the open goal: ' + JSON.stringify(await ev(FOLDER_ROWS)), 15000);
        const brief = (open, seq) => ev(`import((window.__coralStatic || '/static/') + 'goals_feed.js').then(m => { m.publishGoalsBrief({ [${JSON.stringify(team)}]: { open: ${open}, seq: ${seq} } }); return true; })`);
        await brief(1, 1); // the frame the page saw while the goal was open
        await post(`/goals/${made.id}/close`, { state: 'done', reason: 'finished', subscriber_id: 'Operator' }); // closed from outside the page, as an agent or another browser would
        await brief(0, 2); // and the next frame, its counter moved
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Goals0?$/.test(w))`, 'Goals drops the closed goal within 8 s, not on its next poll: ' + JSON.stringify(await ev(FOLDER_ROWS)), 8000);
        console.log('PASS the Goals count follows a closed goal at once');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
