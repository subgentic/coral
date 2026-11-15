// The phone team page's Needs you list and Branches tab start at the same left edge as Tasks and Goals (#17131 item 2, walk report): they had no side padding, so their text sat against the screen edge. 390 px.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-pad-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`document.documentElement.dataset.theme = 'dark'; window.syncMobileAgentList && window.syncMobileAgentList(); window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(TEAM)}, { tab: 'agents' }); true`);
        await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(TEAM)}`, 'team page', 10000); await settle(1500);
        const left = {};
        for (const t of ['needs', 'branches', 'tasks']) {
            await ev(`window.openTeamPage(${JSON.stringify(TEAM)}, { tab: ${JSON.stringify(t)} }); true`); await settle(1200);
            const m = await ev(`(() => { const out = {}; const sc = document.querySelector('#team-page-view') || document.body; const inp = [...document.querySelectorAll('input[type=search], input[type=text]')].filter(i => i.getClientRects().length).map(i => Math.round(i.getBoundingClientRect().left)); const txt = []; const w = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.width && b.left >= 0 && b.left < 390 && b.top > 120 && b.top < 760) txt.push([Math.round(b.left), n.textContent.trim().slice(0, 24)]); } txt.sort((a, b) => a[0] - b[0]); return { inputs: inp, leftmost: txt.slice(0, 4) }; })()`);
            left[t] = m.leftmost.length ? m.leftmost[0][0] : 999; await shot(`pad-${t}`);
        }
        const bad = ['needs', 'branches'].filter(t => Math.abs(left[t] - left.tasks) > 2);
        if (bad.length) { console.error('FAIL the phone team page lines its tabs up on one left edge (#17131 item 2): ' + JSON.stringify(left)); process.exitCode = 1; }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (!process.exitCode) console.log('team_phone_padding_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
