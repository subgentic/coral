// A goal's page: the progress meter under "N of M tasks done" is a short meter that sits with its label, not a line across the whole page (#16540, the Operator: "This green line doesn't need to be that long").
// It is no wider than 240 px and no wider than the page's content, on the goal's page in the Inbox and on the team page. 1440 and 390 px, dark and light; shots go to CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'goal-bar-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const created = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'A goal with a meter', outcome: 'A short meter', done_when: 'The meter is short' });
        assert.equal(created.status, 201); const id = created.body.id;
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        for (const t of ['One', 'Two']) assert.ok((await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: `Task ${t}`, body: 'x', priority: 'medium', goal_id: id })).status < 300);
        for (const [width, mobile] of [[1440, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const [mount, url] of [['#inbox-page', `/inbox/goals/${board}/${id}`], ['#team-panel-goals', `/team/${board}/goals/${id}`]]) {
                await load(url);
                for (const theme of ['dark', 'light']) {
                    const at = `${width} px, ${mount}, ${theme}: `;
                    await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
                    await waitFor(`!!document.querySelector('${mount} .goals-progress') && !!document.querySelector('${mount} .goal-rollup')`, `${at}the goal page's meter`, 15000);
                    const m = await ev(`(() => { const bar = document.querySelector('${mount} .goal-rollup'), label = document.querySelector('${mount} .goals-progress'), main = bar.closest('.goal-main') || bar.parentElement, r = e => e.getBoundingClientRect(); return { bar: Math.round(r(bar).width), label: Math.round(r(label).width), main: Math.round(r(main).width), h: Math.round(r(bar).height), left: Math.round(r(bar).left), labelLeft: Math.round(r(label).left) }; })()`);
                    assert.ok(m.bar > 0 && m.bar <= 240, `${at}the meter is a short one, 240 px at most: ${JSON.stringify(m)}`);
                    assert.ok(m.bar <= m.main, `${at}the meter is inside the page's content: ${JSON.stringify(m)}`);
                    assert.ok(Math.abs(m.left - m.labelLeft) <= 2, `${at}the meter starts where its label does: ${JSON.stringify(m)}`);
                    await shot(`goal-progress-${width}-${mount.slice(1)}-${theme}`);
                }
            }
        }
    } finally { try { await removeBoards(ev, [board]); } catch (e) {} await client.close(); }
    console.log('goal_progress_bar_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
