// The Board tab's controls (the All / Questions / Mentions me pills and the Table | Chat switch) stay on ONE line on a phone (walk 74, #17733 item 3): at 320 and 360 px they wrapped to two,
// 112 px tall instead of 58, which is a row of the list gone on a screen that shows four. The pills scroll sideways inside their strip (their fade says so); the switch keeps its size.
// A real board on the isolated dev server (removed again). Shots in CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { openBoardPage } = require('./helpers/team_board');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'bt-' + Date.now().toString(36);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status, 200);
        for (let i = 0; i < 4; i++) assert.ok((await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'orch', content: `Message number ${i}, a few words to fill a row of the board table.` })).status < 300);
        await ev(`localStorage.setItem('coral.board.view', 'table'); true`);
        await openBoardPage(ev, waitFor, B);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 4`, 'the rows', 15000);
        for (const w of [320, 360, 390, 412]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 2, mobile: true });
            await waitFor(`document.documentElement.clientWidth <= ${w + 12}`, `${w} px`, 5000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the bar lays out again after the resize (a page layout, no event)
            const g = await ev(`(() => { const t = document.querySelector('.mb-table-tools'), kids = [...t.children].map(c => c.getBoundingClientRect()); const sw = document.querySelector('.mb-view-switch').getBoundingClientRect(); return { h: Math.round(t.getBoundingClientRect().height), tops: kids.map(k => Math.round(k.top)), right: Math.round(Math.max(...kids.map(k => k.right))), switchW: Math.round(sw.width), wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
            if (new Set(g.tops).size !== 1) problems.push(`${w}: the pills and the Table | Chat switch are on different lines: ${JSON.stringify(g)}`);
            if (g.right > w) problems.push(`${w}: the controls run off the screen: ${JSON.stringify(g)}`);
            if (g.switchW < 100) problems.push(`${w}: the switch was squeezed to ${g.switchW} px`);
            if (!g.wide) problems.push(`${w}: the page is wider than the screen`);
            await shot(`board-tools-${w}`);
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the Board tab controls stay on one line:\n  ' + problems.join('\n  '));
    console.log('PASS the Board tab controls stay on one line on a phone');
})().catch(e => { console.error(e); process.exitCode = 1; });
