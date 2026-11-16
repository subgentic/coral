// #18049: the "While you were away" clock started at the first Needs you draw, so a tab opened on another view and left for over five minutes before Needs you was first opened reported no gap. The clock now starts at the
// page's load: the first input after a gap since then says the line. The gap is made by moving the page's clock (Date.now) forward before the module is first imported, then pressing something. The server's answer is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const LINE = `document.querySelector('#group-table-view .inbox-away')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => { const R = window.fetch.bind(window);
            window.fetch = (u, o) => /\\/api\\/away/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ tasks_done: 2, goals_done: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })) : R(u, o);
            const RN = Date.now; Date.now = () => RN.call(Date) + 12 * 60000; // twelve minutes pass on the page's clock with the tab on another view
            window.switchNavTab && window.switchNavTab('hub-inbox');
            const m = await import(${S} + 'inbox_tab.js'); await m.selectInboxTab('needs'); return true; })()`);
        await waitFor(`!!document.querySelector('#group-table-view')`, 'Needs you', 15000);
        await ev(`import(${S} + 'inbox_away.js').then(() => true)`);
        await ev(`document.dispatchEvent(new Event('pointerdown')); true`);
        await waitFor(`!!${LINE}`, 'the line for the time since the page loaded', 8000);
        const text = await ev(`${LINE}.textContent`);
        assert.match(text, /^While you were away \((1[1-3]) min\): 2 tasks done/, text);
        console.log('[PASS] a tab left on another view is away from its load: ' + text);
        // The other half (QA, #18049): a person who presses something on another view at +12 minutes is not away when Needs you is first drawn: the clock is the real last input (fetch_share.js keeps it), not the page load.
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => { const R = window.fetch.bind(window);
            window.fetch = (u, o) => /\\/api\\/away/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ tasks_done: 2, goals_done: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })) : R(u, o);
            const RN = Date.now; Date.now = () => RN.call(Date) + 12 * 60000;
            document.dispatchEvent(new Event('pointerdown')); // pressed something on another view, twelve minutes in
            window.switchNavTab && window.switchNavTab('hub-inbox');
            const m = await import(${S} + 'inbox_tab.js'); await m.selectInboxTab('needs'); return true; })()`);
        await waitFor(`!!document.querySelector('#group-table-view')`, 'Needs you', 15000);
        await ev(`import(${S} + 'inbox_away.js').then(() => true)`);
        await ev(`document.dispatchEvent(new Event('pointerdown')); true`);
        await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: nothing is expected to appear; give a wrong line time to show
        assert.equal(await ev(`!!${LINE}`), false, 'a person who pressed something seconds ago is not away');
        console.log('[PASS] input on another view before Needs you opens means no line');
    } finally { await client.close(); }
    console.log('\nAll page-load away checks passed');
})().catch(e => { console.error(e); process.exit(1); });
