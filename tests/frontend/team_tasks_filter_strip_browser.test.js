// Team Tasks keeps a strip of four state pills (Open, In review, Blocked, Done) and moves the other four (All, Queued, In progress, Needs review) into the Filters panel's Show select (#15829, design guidelines T6):
// the header fits one row, every old state is still reachable, a state in the panel shows as a removable chip, and a board filter (Priority) keeps working beside it. 1280, 1440, 390 and 200% text, dark and light.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const board = 'task-gh-' + Date.now().toString(36);
const SHORT = 'Ship the first slice';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const api = (p, body) => ev(`fetch(${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
        assert.equal((await api(`/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        for (const title of [SHORT]) {
            const goal = await api(`/api/board/${board}/goals`, { title, outcome: 'x', subscriber_id: 'Operator' });
            assert.ok(goal.status < 300 && goal.body.id, 'the goal is made: ' + JSON.stringify(goal));
            for (let i = 1; i <= 2; i++) assert.equal((await api(`/api/board/${board}/tasks`, { subscriber_id: 'Boss', assigned_to: 'Boss', goal_id: goal.body.id, title: `Task ${i} of ${title.slice(0, 12)}`, body: 'Details are on the task page.' })).status, 201);
        }
        for (const [width, theme, zoom] of [[1280, 'dark', ''], [1440, 'light', ''], [1440, 'dark', '200%'], [390, 'dark', ''], [390, 'light', '']]) {
            const at = `${width} ${theme}${zoom ? ' ' + zoom + ' text' : ''}`;
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: `${BASE}/team/${board}/tasks` }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr, #team-panel-tasks [data-task-id]').length >= 2`, at + ': the task rows', 15000);
                await ev(framesJs(3));
                const ok = (cond, what, extra) => { if (!cond) failures.push(`${at}: ${what} ${JSON.stringify(extra === undefined ? null : extra)}`); };
                const strip = () => ev(`(() => { const p = document.querySelector('#team-panel-tasks'); const row = p.querySelector('.list-bar-search-row'); const g = p.querySelector('.team-tb-pills'), sel = p.querySelector('.team-tb-select');
                    const vis = e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
                    return { keys: [...p.querySelectorAll('.team-tb-pills .goals-chip')].map(c => c.dataset.filter), pressed: [...p.querySelectorAll('.team-tb-pills .goals-chip[aria-pressed=true]')].map(c => c.dataset.filter), groupShown: vis(g), selectShown: vis(sel),
                        selectOptions: sel ? [...sel.querySelectorAll('option')].length : 0, rowH: row ? Math.round(row.getBoundingClientRect().height) : 0, rowW: row ? Math.round(row.scrollWidth - row.clientWidth) : 0, chips: [...p.querySelectorAll('.team-tb-chip')].map(c => c.textContent.trim()), sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                const s0 = await strip();
                ok(JSON.stringify(s0.keys) === JSON.stringify(['open', 'review', 'blocked', 'done']), 'the strip is Open, In review, Blocked, Done', s0.keys);
                ok(s0.groupShown || s0.selectShown, 'the strip (or its compact select) is shown', s0);
                if (s0.selectShown) ok(s0.selectOptions === 4, 'the compact select offers the same four', s0);
                ok(s0.sideways <= 1 && s0.rowW <= 1, 'the header does not overflow sideways', s0);
                await ev(`document.querySelector('#team-panel-tasks .list-bar-toggle').click(); true`);
                await waitFor(`!!document.querySelector('#team-tasks-show')`, at + ': the Show select in the panel', 8000);
                const opts = await ev(`[...document.querySelectorAll('#team-tasks-show option')].map(o => o.value)`);
                ok(JSON.stringify(opts) === JSON.stringify(['open', 'all', 'queued', 'active', 'blocked', 'review', 'needs_review', 'done']), 'every old state is in the Show select', opts);
                await ev(`(() => { const s = document.querySelector('#team-tasks-show'); s.value = 'queued'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await ev(framesJs(3));
                const s1 = await strip();
                const rows = await ev(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length`);
                ok(s1.pressed.length === 0, 'no strip pill is pressed while a panel state is on', s1.pressed);
                ok(s1.chips.some(t => /Show: Queued/.test(t)), 'a chip says Show: Queued', s1.chips);
                ok(rows === 2, 'the two queued tasks are listed', rows);
                if (['1280 dark', '1440 light', '390 dark'].includes(at)) await shot('team-tasks-strip-' + at.replace(/ /g, '-'));
                await ev(`(() => { const s = document.querySelector('#team-tasks-show'); s.value = 'open'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await ev(framesJs(3));
                const s2 = await strip();
                ok(s2.pressed.join() === 'open' && !s2.chips.some(t => /Show:/.test(t)), 'back to Open: its pill is pressed and the chip is gone', s2);
                await ev(`(() => { const p = document.querySelector('#tk-priority'); p.value = 'high'; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await ev(framesJs(3));
                const s3 = await strip();
                ok(s3.chips.some(t => /Priority/.test(t)), 'a board filter (Priority) still makes its chip beside the strip', s3.chips);
                await ev(`(() => { const p = document.querySelector('#tk-priority'); p.value = ''; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); // the filter is kept for the board: leave it off for the next size
                await ev(framesJs(3));
            } catch (e) { failures.push(`${at}: ${e.message}`); }
        }
    } finally { try { await removeBoards(ev, [board]); } catch (e) {} await client.close(); }
    assert.deepEqual(failures, [], 'Team Tasks filter strip:\n  ' + failures.join('\n  '));
    console.log('PASS team Tasks keeps a strip of four states and the rest in the Filters panel');
})().catch(e => { console.error(e); process.exit(1); });
