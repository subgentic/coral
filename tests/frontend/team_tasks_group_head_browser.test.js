// Team Tasks groups its rows under the goal's title (#15828, design guidelines T5): the heading is in sentence case (not capitals), on one line, cut with an ellipsis, the full title in its tooltip,
// and no heading is wider than the table (no sideways scroll). 1440 and 390, dark and light, 200% text. A real board with a goal whose title is 150 letters and a short one; isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const board = 'task-gh-' + Date.now().toString(36);
const LONG = 'Make every list on the team page read as one family: the same header, the same filters, the same status marks, the same one-line rows, the same menus, the same quiet buttons, so nobody asks';
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
        for (const title of [LONG, SHORT]) {
            const goal = await api(`/api/board/${board}/goals`, { title, outcome: 'x', subscriber_id: 'Operator' });
            assert.ok(goal.status < 300 && goal.body.id, 'the goal is made: ' + JSON.stringify(goal));
            for (let i = 1; i <= 2; i++) assert.equal((await api(`/api/board/${board}/tasks`, { subscriber_id: 'Boss', assigned_to: 'Boss', goal_id: goal.body.id, title: `Task ${i} of ${title.slice(0, 12)}`, body: 'Details are on the task page.' })).status, 201);
        }
        for (const [width, theme, zoom] of [[1440, 'dark', ''], [1440, 'light', ''], [1440, 'dark', '200%'], [390, 'dark', ''], [390, 'light', '']]) {
            const at = `${width} ${theme}${zoom ? ' ' + zoom + ' text' : ''}`;
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: `${BASE}/team/${board}/tasks` }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr').length >= 4`, at + ': the task rows', 15000);
                await ev(framesJs(3));
                const heads = await ev(`(() => { const box = document.querySelector('#team-panel-tasks .dt-box'); const sc = box.querySelector('.dt-scroll') || box;
                    return { box: { w: Math.round(box.getBoundingClientRect().width), sideways: Math.max(box.scrollWidth - box.clientWidth, sc.scrollWidth - sc.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth) },
                        heads: [...document.querySelectorAll('#team-panel-tasks .dt-group:not(.dt-group-task) th')].map(th => { const cs = getComputedStyle(th), r = th.getBoundingClientRect(); return { text: th.textContent, tip: th.title, transform: cs.textTransform, overflow: cs.textOverflow, wrap: cs.whiteSpace, w: Math.round(r.width), cut: th.scrollWidth > th.clientWidth }; }) }; })()`);
                const ok = (cond, what) => { if (!cond) failures.push(`${at}: ${what} ${JSON.stringify({ box: heads.box, heads: heads.heads.map(h => ({ ...h, text: h.text.slice(0, 14), tip: h.tip === h.text })) })}`); };
                ok(heads.heads.length === 2, 'a heading per goal');
                for (const h of heads.heads) {
                    ok(h.transform === 'none' && h.text !== h.text.toUpperCase(), 'sentence case, not capitals');
                    ok(h.overflow === 'ellipsis' && h.wrap === 'nowrap', 'one line cut with an ellipsis');
                    ok(h.tip === h.text, 'the full title is the tooltip');
                    ok(h.w <= heads.box.w, 'no heading wider than the table');
                }
                ok((width === 1440 && !zoom) || heads.heads.some(h => h.text === LONG && h.cut), 'the very long title is cut (a wide table may show it whole)');
                ok(heads.heads.some(h => h.text === SHORT && !h.cut), 'a short title is whole');
                ok(heads.box.sideways <= 1, 'no sideways scroll');
                if (['1440 dark', '1440 light', '390 dark'].includes(at)) await shot('team-tasks-groups-' + at.replace(/ /g, '-'));
            } catch (e) { failures.push(`${at}: ${e.message}`); }
        }
    } finally { try { await removeBoards(ev, [board]); } catch (e) {} await client.close(); }
    assert.deepEqual(failures, [], 'Team Tasks goal headings:\n  ' + failures.join('\n  '));
    console.log('PASS team Tasks goal headings are sentence case, one line, cut with an ellipsis');
})().catch(e => { console.error(e); process.exit(1); });
