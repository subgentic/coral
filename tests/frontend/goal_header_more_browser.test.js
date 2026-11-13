// A goal's page header keeps two buttons and a More menu (#15832, design guidelines G1): Add task and Mark done (Reopen for a closed goal) are buttons, Mark done the one blue; the way to the team page,
// Edit goal, Change driver and Move to another team are in More (a phone's More also holds Copy for an agent). One row at 1440 and 1024; 1440 and 390 px, dark and light, and 200% text; nothing wraps off screen.
// Real boards on the isolated dev server; CORAL_SCREENSHOT_DIR gets the shots.
const assert = require('node:assert/strict');
if (process.platform === 'win32') { console.log('goal_header_more_browser: SKIPPED on Windows for now (#14876); Linux and Mac keep running it'); process.exit(0); }
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'goal-head-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async (url, fs16, theme) => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await ev(`document.documentElement.style.fontSize = '${fs16}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`); };
    const M = '#inbox-page';
    const read = () => ev(`(() => { const acts = document.querySelector('${M} .goal-head-actions'), vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden', r = e => e.getBoundingClientRect();
        const btns = [...acts.querySelectorAll(':scope > button, :scope > .task-more > button')].filter(vis);
        const menu = [...acts.querySelectorAll('.task-more-menu [role=menuitem]')].map(b => b.textContent.trim());
        return { texts: btns.map(b => b.textContent.trim().replace(/^(Mark done).*/, '$1')), blue: btns.filter(b => b.classList.contains('btn-primary')).map(b => b.textContent.trim().replace(/^(Mark done).*/, '$1')),
            tops: [...new Set(btns.map(b => Math.round(r(b).top)))].length, menu, teamLinkOutside: !!document.querySelector('${M} .goal-back-row > .goal-team-link'), vw: innerWidth,
            inside: btns.every(b => r(b).left >= 0 && r(b).right <= innerWidth + 0.5), sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/', 16, 'light');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const mkGoal = async (title, close) => {
            const c = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title, outcome: 'Less clutter', done_when: 'Two buttons' }); assert.equal(c.status, 201);
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${c.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
            const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: 'One task ' + c.body.id, body: 'x', priority: 'medium', goal_id: c.body.id }); assert.ok(t.status < 300);
            if (close) assert.equal((await api('POST', `/api/board/${board}/goals/${c.body.id}/close`, { subscriber_id: 'Operator', reason: 'shipped' })).status, 200);
            return c.body.id; };
        const openId = await mkGoal('Make the goal header calm', false), closedId = await mkGoal('A goal that was closed', true);
        const failures = [];
        const ok = (c, m, d) => { if (!c) failures.push(m + (d === undefined ? '' : ' ' + JSON.stringify(d))); };
        for (const [w, h, mobile, fs16, theme, tag, rowCheck] of [[1440, 900, false, 16, 'dark', '1440 dark', true], [1440, 900, false, 16, 'light', '1440 light', true], [1024, 800, false, 16, 'light', '1024 light', true], [1440, 900, false, 32, 'dark', '1440 dark 200%', false], [390, 844, true, 16, 'dark', '390 dark', false], [390, 844, true, 16, 'light', '390 light', false], [390, 844, true, 32, 'light', '390 200%', false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            try {
                await load(`/inbox/goals/${board}/${openId}`, fs16, theme);
                await waitFor(`!!document.querySelector('${M} .goal-head-actions .goals-close')`, `${tag}: the goal page`, 15000);
                const d = await read();
                ok(JSON.stringify(d.texts) === JSON.stringify(['Add task', 'Mark done', 'More']), `${tag}: the buttons are Add task, Mark done and More`, d.texts);
                ok(JSON.stringify(d.blue) === JSON.stringify(['Mark done']), `${tag}: Mark done is the one blue button`, d.blue);
                ok(!d.teamLinkOutside, `${tag}: the team link is not a loose link in the header`);
                ok(d.inside && !d.sideways, `${tag}: nothing is off screen or scrolls sideways`, d);
                if (rowCheck) ok(d.tops === 1, `${tag}: the buttons are one row`, d.tops);
                await ev(`document.querySelector('${M} .goal-head-actions .task-more-btn').click(); true`);
                await waitFor(`!document.querySelector('${M} .goal-head-actions .task-more-menu').hidden`, `${tag}: More opens`, 4000);
                const m = (await read()).menu;
                const want = ['Open on team page', 'Edit goal', 'Change driver', 'Move to another team'].concat(mobile ? ['Copy for an agent'] : []);
                ok(JSON.stringify(m) === JSON.stringify(want), `${tag}: More holds the rest`, m);
                if (['1440 dark', '1440 light', '390 dark'].includes(tag)) await shot('goal-header-' + tag.replace(/ /g, '-'));
                await ev(`document.querySelector('${M} .goal-head-actions .task-more-btn').click(); true`);
                if (w === 1440 && fs16 === 16 && theme === 'dark') { // a closed goal: Add task and Reopen, no blue
                    await load(`/inbox/goals/${board}/${closedId}`, fs16, theme);
                    await waitFor(`!!document.querySelector('${M} .goal-head-actions .goals-reopen')`, `${tag}: the closed goal page`, 15000);
                    const c = await read();
                    ok(JSON.stringify(c.texts) === JSON.stringify(['Add task', 'Reopen']) || JSON.stringify(c.texts) === JSON.stringify(['Add task', 'Reopen', 'More']), `${tag}: a closed goal has Add task and Reopen`, c.texts);
                    ok(c.blue.length === 0, `${tag}: a closed goal has no blue button`, c.blue);
                }
            } catch (e) { failures.push(`${tag}: ${e.message}`); }
        }
        assert.deepEqual(failures, [], 'Goal header:\n  ' + failures.join('\n  '));
        console.log('PASS goal header: Add task, Mark done and More at 1440, 1024 and 390, dark and light, 200% text');
    } finally { await removeBoards(ev, [board]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
