// coral-hub Security's four conditions on the Inbox's live goals read (#13389, #9551 "never polled"), pinned: (1) only while the tab is visible, none when hidden; (2) one request in flight, never overlapping;
// (3) a failed read backs off (the gap doubles), no retry loop; (4) at most one read per gap however many live updates arrive, so far inside the Hub's 60 reads a minute per computer. The gap is 2 s for the first two checks and 300 ms for the failing one (__coralGoalsMs).
// The /api/goals answer is stood in for so it can be slow or failing; everything else is the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, settle } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await client.Emulation.setFocusEmulationEnabled({ enabled: true }); // a visible page: the live goals read is for a tab that is on screen
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await settle(ev, 600, 300);
        await ev(`(() => { const real = window.fetch; window.__goalReads = { n: 0, inflight: 0, maxInflight: 0, mode: 'ok' };
            window.fetch = function (u, o) { if (!/\\/api\\/goals\\?/.test(String(u))) return real.apply(this, arguments); const g = window.__goalReads; g.n++; g.inflight++; g.maxInflight = Math.max(g.maxInflight, g.inflight);
                return new Promise(res => setTimeout(() => { g.inflight--; res(g.mode === 'fail' ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ goals: [] }), { headers: { 'Content-Type': 'application/json' } })); }, 120)); }; // sleep-ok: the stand-in server answers after 120 ms
            globalThis.__coralGoalsMs = 2000; return true; })()`);
        const tick = n => ev(`(async () => { const m = await import((window.__coralStatic||'/static/')+'inbox_tab.js'); for (let i = 0; i < ${n}; i++) { m.updateInboxTab(); await new Promise(r => setTimeout(r, 20)); /* sleep-ok: spacing between live updates */ } return true; })()`);
        const reads = () => ev(`window.__goalReads.n`);
        const wait = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the gap between reads is time itself

        // (4) and (2): thirty live updates inside one gap are one read, and no two overlap
        await wait(2100); const n0 = await reads(); await tick(30); await wait(200); // sleep-ok: the Inbox's own first read was inside the last gap: wait it out, so the thirty updates start a gap of their own
        assert.equal((await reads()) - n0, 1, 'thirty live updates in one gap are one goals read');
        assert.equal(await ev(`window.__goalReads.maxInflight`), 1, 'never two reads at once');

        // (1) hidden: none
        await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); true`);
        await wait(2100); const n1 = await reads(); await tick(10); await wait(200); // sleep-ok: the gap between reads is time itself
        assert.equal(await reads(), n1, 'a hidden tab reads nothing');
        await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); true`);

        // (3) failing: the gap doubles (300 ms, then 600, 1200): a burst of updates over 2 s makes a few reads, not one per update, and each read waits longer than the last
        await ev(`window.__goalReads.mode = 'fail'; globalThis.__coralGoalsMs = 300; true`);
        await wait(700); const n2 = await reads(); const t0 = Date.now(); let stamps = []; // sleep-ok: the gap between reads is time itself
        for (let i = 0; i < 100; i++) { await tick(1); const n = (await reads()) - n2; if (n > stamps.length) stamps.push(Date.now() - t0); await wait(20); } // sleep-ok: 100 updates over about 4 s
        assert.ok(stamps.length >= 2 && stamps.length <= 5, 'failing reads are backed off, a handful in 4 s, not one per update: ' + JSON.stringify(stamps));
        for (let i = 2; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] > stamps[i - 1] - stamps[i - 2] - 150, 'each gap is longer than the one before: ' + JSON.stringify(stamps));
        console.log('\nPASS the live goals read: visible only, one in flight, backed off on failure, one per gap');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
