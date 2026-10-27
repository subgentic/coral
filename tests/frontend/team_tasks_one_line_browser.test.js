// #8936 (Goal #79, the Operator): a task list that wraps (the team Tasks tab in a narrow box or on a phone) shows ONE line per row: the status chip, the title with an ellipsis and the agent's avatar, like the dock's rows (#8792).
// The number, the time, the goal and the file count are on the task's page, not on the row. 1280 with the table's box made narrow (what a wide window with the preview open gives) and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const fs = require('node:fs'), path = require('node:path');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const board = 'task-line-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const api = (p, body) => ev(`fetch(${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
        assert.equal((await api(`/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        const goal = await api(`/api/board/${board}/goals`, { title: 'A goal with a long title that used to be a second line', outcome: 'x', subscriber_id: 'Operator' });
        for (let i = 1; i <= 3; i++) assert.equal((await api(`/api/board/${board}/tasks`, { subscriber_id: 'Boss', assigned_to: 'Boss', goal_id: goal.body.id, title: `Task ${i}: a deliberately long title that must be cut with an ellipsis instead of pushing the status or the avatar onto another line`, body: 'Details are on the task page.', priority: 'high' })).status, 201);
        for (const [width, narrow] of [[1280, true], [390, false]]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: `${BASE}/team/${board}/tasks` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr').length >= 3`, 'the task rows', 15000);
                if (narrow) await ev(`(() => { const b = document.querySelector('#team-panel-tasks .dt-box'); b.parentElement.style.width = '520px'; b.style.width = '520px'; return true; })()`);
                await waitFor(`document.querySelector('#team-panel-tasks .dt-box').classList.contains('dt-folded')`, 'the folded table', 8000);
                const rows = await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr')].map(r => { const v = e => !!e && e.getClientRects().length > 0, rect = e => { const b = e && e.getBoundingClientRect(); return b ? { x: b.x, mid: b.y + b.height / 2, w: b.width, h: b.height } : null; };
                    const chip = r.querySelector('.dt-chip'), title = r.querySelector('button.dt-primary'), av = r.querySelector('.dt-avatar'); const row = r.getBoundingClientRect();
                    const extras = ['.dt-id', '.dt-subtitle', 'td[data-key="goal"]', 'td[data-key="updated"]', 'td[data-key="files"]', 'button.dt-files'].filter(s => [...r.querySelectorAll(s)].some(v));
                    return { chip: v(chip) && rect(chip), title: v(title) && rect(title), av: v(av) && rect(av), h: Math.round(row.height), extras, ellipsis: title ? getComputedStyle(title).textOverflow : '', nowrap: title ? getComputedStyle(title).whiteSpace : '', cut: !!title && title.scrollWidth > title.clientWidth, scrolls: r.closest('.dt-box').scrollWidth - r.closest('.dt-box').clientWidth }; })`);
                for (const r of rows) {
                    assert.ok(r.chip && r.title && r.av, 'status, title and avatar are on the row: ' + JSON.stringify(r));
                    assert.ok(Math.abs(r.chip.mid - r.title.mid) < 6 && Math.abs(r.av.mid - r.title.mid) < 6, 'all three share one line: ' + JSON.stringify(r));
                    assert.ok(r.chip.x < r.title.x && r.title.x < r.av.x, 'status, title, avatar, in that order');
                    assert.deepEqual(r.extras, [], 'the number, time, goal and files are not on the row');
                    assert.ok(r.h <= 60, 'one line: the row is at most 60 px, not three lines: ' + r.h);
                    assert.ok(r.scrolls <= 1, 'no sideways scroll');
                    assert.equal(r.ellipsis, 'ellipsis', 'the title is cut with an ellipsis'); assert.equal(r.nowrap, 'nowrap', 'and stays on one line'); assert.ok(r.cut, 'a long title is really cut, not wrapped (scrollWidth ' + JSON.stringify(r) + ')');
                }
                if (width === 390) { // 200% text on a phone: the box is about 12 rem, under the 20 rem container rule that used to let the title wrap (UI Reviewer, #8936 notes): the title still keeps one line and is cut with an ellipsis
                    await ev(`document.documentElement.style.fontSize = '32px'; true`);
                    await waitFor(`document.querySelector('#team-panel-tasks .dt-box').getBoundingClientRect().width / 32 < 20`, 'the narrow box at 200% text', 8000);
                    const big = await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr')].map(r => { const t = r.querySelector('button.dt-primary'), c = getComputedStyle(t), box = r.closest('.dt-box'); return { nowrap: c.whiteSpace, ellipsis: c.textOverflow, h: Math.round(t.getBoundingClientRect().height), lh: parseFloat(c.lineHeight) || parseFloat(c.fontSize) * 1.3, over: box.scrollWidth - box.clientWidth, cut: t.scrollWidth > t.clientWidth }; })`);
                    for (const r of big) { assert.equal(r.nowrap, 'nowrap', '200% text: the title stays on one line: ' + JSON.stringify(r)); assert.equal(r.ellipsis, 'ellipsis', '200% text: cut with an ellipsis'); assert.ok(r.h < 70, '200% text: one line high: ' + JSON.stringify(r)); assert.ok(r.cut && r.over <= 1, '200% text: cut, no sideways scroll'); }
                    await ev(`document.documentElement.style.fontSize = ''; true`);
                }
                const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
                if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `team-tasks-one-line-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                console.log(`PASS ${width}: a folded task row is one line`);
            } catch (e) { failures.push(width + ': ' + e.message); console.error(failures.at(-1)); }
        }
        assert.deepEqual(failures, []);
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
