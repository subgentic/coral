// coral-hub Security's conditions on the Inbox's live reads of goals and proposals (#13389, #9551 "never polled"), pinned at the readers' own entries: (1) a live update reads only while the browser tab is visible, none when hidden;
// (2) one request in flight per list, never overlapping, whoever asks (a live update, the Inbox being shown); (3) a failed read backs off (the gap doubles), no retry loop; (4) at most one read per gap however many live updates arrive.
// The recorder is installed before the page starts, so the first reads are counted too. The gaps are 2 s (__coralGoalsMs, __coralProposalsMs) for the first checks and 300 ms for the failing one.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, settle } = require('./helpers/wait');

const RECORDER = `(() => { const real = window.fetch; window.__reads = { goals: { n: 0, inflight: 0, max: 0, at: [] }, proposals: { n: 0, inflight: 0, max: 0, at: [] }, mode: 'ok' };
    window.fetch = function (u, o) { const url = String(u), which = /\\/api\\/goals\\?/.test(url) ? 'goals' : /\\/api\\/proposals\\?/.test(url) ? 'proposals' : ''; if (!which) return real.apply(this, arguments);
        const r = window.__reads[which]; r.n++; r.at.push(Date.now()); r.inflight++; r.max = Math.max(r.max, r.inflight);
        return new Promise(res => setTimeout(() => { r.inflight--; res(window.__reads.mode === 'fail' ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(which === 'goals' ? { goals: [] } : { proposals: [] }), { headers: { 'Content-Type': 'application/json' } })); }, 120)); }; })();`; // sleep-ok: the stand-in server answers after 120 ms

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await client.Emulation.setFocusEmulationEnabled({ enabled: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: RECORDER + ` globalThis.__coralGoalsMs = 2000; globalThis.__coralProposalsMs = 2000;` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await settle(ev, 600, 300);
        const n = which => ev(`window.__reads.${which}.n`);
        const wait = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the gap between reads is time itself
        const tick = k => ev(`(async () => { const m = await import((window.__coralStatic||'/static/')+'inbox_tab.js'); for (let i = 0; i < ${k}; i++) { m.updateInboxTab(); await new Promise(r => setTimeout(r, 20)); /* sleep-ok: spacing between live updates */ } return true; })()`);

        // the first reads were seen by the recorder, and showing the Inbox with a live update at the same moment never overlaps
        assert.ok(await n('goals') >= 1 && await n('proposals') >= 1, 'the first goals and proposals reads were recorded: ' + [await n('goals'), await n('proposals')]);
        await ev(`(async () => { const m = await import((window.__coralStatic||'/static/')+'inbox_tab.js'); const s = await import((window.__coralStatic||'/static/')+'inbox_sidebar.js'); await Promise.all([s.showInbox({ quiet: true }), s.showInbox({ quiet: true }), tick0(m)]); function tick0(m) { m.updateInboxTab(); m.updateInboxTab(); return true; } return true; })()`);
        await settle(ev, 400, 200);
        for (const which of ['goals', 'proposals']) assert.equal(await ev(`window.__reads.${which}.max`), 1, `${which}: never two reads at once, whoever asks`);

        // (4) one read per gap: thirty live updates inside one gap are one read of each list
        await wait(2200); const g0 = await n('goals'), p0 = await n('proposals'); const t4 = Date.now(); await tick(30); await wait(300); // sleep-ok: the gap between reads is time itself
        // read from the recorder's own timestamps: a stalled page makes the window longer, and a second read a whole gap later is correct, so the bound is one read per gap of the window
        const win = Date.now() - t4;
        for (const [w, base, what] of [['goals', g0, 'goals read'], ['proposals', p0, 'proposals read']]) {
            const at = (await ev(`window.__reads.${w}.at`)).slice(base);
            assert.ok(at.length >= 1 && at.length <= 1 + Math.floor(win / 1900), `thirty live updates in one gap are one ${what} (${at.length} in ${win} ms)`);
            for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1900, `${w}: two reads are a gap apart: ${JSON.stringify(at)}`);
        }

        // (1) hidden: none, for both
        await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); true`);
        await wait(2200); const g1 = await n('goals'), p1 = await n('proposals'); await tick(10); await wait(300); // sleep-ok: the gap between reads is time itself
        assert.equal(await n('goals'), g1, 'a hidden tab reads no goals');
        assert.equal(await n('proposals'), p1, 'and no proposals');
        await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); true`);

        // (3) failing: each list's gap doubles (300 ms, 600, 1200): over about 4 s of constant updates a handful of reads, each gap longer than the last
        await ev(`window.__reads.mode = 'fail'; globalThis.__coralGoalsMs = 300; globalThis.__coralProposalsMs = 300; true`);
        await wait(2200); // sleep-ok: the gap between reads is time itself
        const g2 = await n('goals'), p2 = await n('proposals'); const t0 = Date.now(); const stamps = { goals: [], proposals: [] };
        for (let i = 0; i < 100; i++) { await tick(1); for (const w of ['goals', 'proposals']) { const base = w === 'goals' ? g2 : p2; if (await n(w) - base > stamps[w].length) stamps[w].push(Date.now() - t0); } await wait(20); } // sleep-ok: the gap between reads is time itself
        for (const w of ['goals', 'proposals']) {
            const s = stamps[w];
            assert.ok(s.length >= 2 && s.length <= 5, `${w}: failing reads are backed off, a handful in 4 s, not one per update: ${JSON.stringify(s)}`);
            for (let i = 2; i < s.length; i++) assert.ok(s[i] - s[i - 1] > s[i - 1] - s[i - 2] - 150, `${w}: each gap is longer than the one before: ${JSON.stringify(s)}`);
        }
        console.log('\nPASS live goals and proposals reads: first reads seen, no overlap whoever asks, visible tab only, one per gap, backed off on failure');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
