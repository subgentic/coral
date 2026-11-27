// #21853: done is hidden by default, without an active filter. Retain the old
// coral-hide-completed preference's meaning while reversing the checkbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const errors = [];
    const rowCount = `document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setTimezoneOverride({ timezoneId: 'UTC' });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const stored = new URL(location.href).searchParams.get('oldHide');
            if (stored === null) localStorage.removeItem('coral-hide-completed'); else localStorage.setItem('coral-hide-completed', stored);
            const real = window.fetch;
            window.fetch = (u, o) => {
                if (/\\/api\\/board\\/show-done-demo\\/tasks(?:\\?|$)/.test(String(u))) return Promise.resolve(new Response(JSON.stringify({ tasks: [
                    { id: 1, title: 'Write launch draft', status: 'in_progress', assigned_to: 'Writer', created_at: '2026-11-27T08:00:00Z' },
                    { id: 2, title: 'Review landing page', status: 'pending', created_at: '2026-11-27T08:00:00Z' },
                    { id: 3, title: 'Publish first draft', status: 'completed', created_at: '2026-11-27T08:00:00Z' },
                    { id: 4, title: 'Old draft cancelled', status: 'skipped', created_at: '2026-11-27T08:00:00Z' }
                ], total_open: 2, total_completed: 2, next_cursor: '' }), { headers: { 'Content-Type': 'application/json' } }));
                return real(u,o);
            };
        })()` });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
            for (const stored of [null, 'true', 'false']) {
                await Page.navigate({ url: BASE + '/' + (stored === null ? '' : '?oldHide=' + stored) }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await openBoardTasksTab({ ev, waitFor }, 'show-done-demo', 'review-agent');
                await waitFor(`!!document.querySelector('.board-task-hide-toggle input') && ${rowCount} >= 2`, 'task rows and done control', 12000);
                const showing = stored === 'false';
                const snap = await ev(`(() => { const b=document.querySelector('.board-task-hide-toggle input'); return { checked:b.checked, text:b.parentElement.textContent.trim(), rows:${rowCount}, active:document.getElementById('tk-toggle').classList.contains('active'), badge:!document.querySelector('#tk-toggle .display-badge').hidden, clearHidden:document.querySelector('#board-task-bar .list-bar-clear-all').hidden }; })()`);
                if (stored === null && process.env.CORAL_SCREENSHOT_DIR) {
                    await ev(`if (document.getElementById('tk-menu').hidden) document.getElementById('tk-toggle').click(); true`);
                    await ev(`document.fonts.ready.then(() => ${framesJs(2)})`);
                    fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                    fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/show-done-${width}.png`, Buffer.from((await Page.captureScreenshot()).data,'base64'));
                }
                try {
                    assert.match(snap.text, /^Show done \(2\)$/);
                    assert.equal(snap.checked, showing, width + ': saved view ' + stored);
                    assert.equal(snap.rows, showing ? 4 : 2);
                    assert.equal(snap.active, showing); assert.equal(snap.badge, showing);
                    if (!showing) assert.ok(snap.clearHidden, 'default has no Clear filters state');
                    await ev(`document.querySelector('.board-task-hide-toggle input').click(); true`);
                    assert.equal(await ev(rowCount), showing ? 2 : 4, 'toggling changes visibility');
                    assert.equal(await ev(`document.getElementById('tk-toggle').classList.contains('active')`), !showing, 'only Show done on counts as active');
                    assert.equal(await ev(`localStorage.getItem('coral-hide-completed')`), showing ? 'true' : 'false', 'legacy key keeps its meaning');
                } catch (e) { errors.push(`${width}, saved=${stored}: ${e.message}; ${JSON.stringify(snap)}`); }
            }
        }
        assert.deepEqual(errors, []);
        console.log('PASS Show done default, filter badge, toggling and both legacy views at 1280/390');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
