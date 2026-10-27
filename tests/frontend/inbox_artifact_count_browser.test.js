// The Inbox's Artifacts count is read once, not on every screen switch (#9251, from the #9086 report: every Inbox screen re-asked GET /api/team-artifacts?limit=1&offset=0, the slowest request on it, 36 to 74 ms):
// opening the Inbox asks for the count once; opening it again, and switching its folders, within 30 seconds do not; and the Artifacts list's own read keeps the count current. Real dev server, requests counted on the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { window.__counts = []; const real = window.fetch; window.fetch = function (u, o) { const url = typeof u === 'string' ? u : u.url; if (/\\/api\\/team-artifacts\\?[^#]*limit=1(&|$)/.test(url)) window.__counts.push(url); return real.apply(this, arguments); }; return true; })()`);
        const asks = () => ev(`window.__counts.length`);
        const open = async folder => { await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`); await new Promise(r => setTimeout(r, 600)); }; // sleep-ok: the folder draws and its reads settle
        console.log('1. Opening the Inbox asks for the count once');
        await open('needs');
        await waitFor(`window.__counts.length >= 1`, 'the first count read', 8000);
        const first = await asks();
        assert.equal(first, 1, 'one count read on opening: ' + first);
        console.log('2. Switching folders and opening the Inbox again do not ask again');
        for (const folder of ['saved', 'tasks', 'goals', 'needs']) await open(folder);
        await ev(`window.switchNavTab('agents'); true`); await open('needs'); await open('saved');
        assert.equal(await asks(), 1, 'still one count read after 6 folder switches and a second opening: ' + await asks());
        console.log('   ✓');
        console.log('PASS inbox artifact count: read once on opening, not on every screen switch');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
