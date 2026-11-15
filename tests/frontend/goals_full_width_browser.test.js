// The Goals page fills its area: no 1440 px max width at 1920 or 2560 px (#18394, after the Operator's full-width rule of #18358 and data_table.css). Real goals on the isolated dev server.
// CORAL_SCREENSHOT_DIR also saves a screenshot at each width.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'goalswide-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        for (const t of ['Ship the pilot', 'Fix the Goals list', 'Write the docs']) check((await api('POST', '/goals', { subscriber_id: 'Operator', title: t, outcome: 'The outcome of ' + t })).status < 300, 'a goal is made: ' + t);
        for (const [w, h] of [[1920, 1000], [2560, 1200]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/team/' + B + '/goals' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr').length >= 3`, at + 'the goal rows', 15000);
            const m = await ev(`(() => { const p = document.querySelector('.goals-page'), host = p.parentElement; return { page: Math.round(p.getBoundingClientRect().width), host: Math.round(host.getBoundingClientRect().width), over: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            check(m.page >= m.host - 2, at + 'the Goals page is as wide as its area (no max width): ' + JSON.stringify(m));
            check(!m.over, at + 'no sideways scroll: ' + JSON.stringify(m));
            const dir = process.env.CORAL_SCREENSHOT_DIR; if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/goals-full-width-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
    } catch (e) { failures.push(e && e.stack || String(e)); }
    await removeBoards(ev, [B]).catch(() => {});
    try { client.close(); } catch { /* closing */ }
    if (failures.length) { for (const f of failures) console.error(f); process.exit(1); }
    console.log('goals_full_width_browser: ok');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
