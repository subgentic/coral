// The chat header's status dot says its state in a word on a phone (#10885, the phone pass item 10: "a hollow circle with no label"). At 390 px an agent that is ready shows "Ready" beside the dot; at 1280 the dot is
// as it was (no word). A mocked agent on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const word = () => ev(`(() => { const d = document.getElementById('terminal-status-dot'), w = document.getElementById('terminal-status-word'); return { text: w.textContent, shown: getComputedStyle(w).display !== 'none' && w.getClientRects().length > 0, dotLabel: d.getAttribute('aria-label'), hidden: w.getAttribute('aria-hidden'), generated: getComputedStyle(d, '::after').content }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('hdr', 'A', 3, { sleeping: false }); true`); await settle(ev, 600); // sleep-ok: the list renders
            await ev(`window.selectLiveSession('hdr', 'claude', 'hdr-id', 'local'); true`);
            await waitFor(`!!document.getElementById('terminal-status-word') && !!document.getElementById('terminal-status-word').dataset.word`, `${w}: the word is known`, 8000); // written as text at <= 600 px only (#11065): a wider header's text has no word
            assert.equal(await ev(`document.getElementById('terminal-status-word').textContent.length > 0`), mobile, `${w}: the word is text ${mobile ? 'on a phone' : 'nowhere else'}`);
            const a = await word();
            assert.ok(a.dotLabel && a.generated !== '"Ready"', `${w}: the dot keeps its name and the word is not generated content: ` + JSON.stringify(a));
            assert.equal(a.hidden, 'true', `${w}: the dot is what a screen reader reads, so the word is not read twice`);
            assert.equal(a.shown, mobile, `${w}: the word is ${mobile ? 'beside the dot' : 'not shown'}: ` + JSON.stringify(a));
        }
        // for an agent in a team (the header also carries its team), at 100% and 200% text: the word is beside the dot, left of the name, never over it (the phone check: "Ready" printed over "Lead Developer / goal-team")
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('tm', 'T', 3, { sleeping: false, board_project: 'goal-team' }); true`); await settle(ev, 600); // sleep-ok: the list renders
        await ev(`window.selectLiveSession('tm', 'claude', 'tm-id', 'local'); true`);
        await waitFor(`!!document.getElementById('terminal-status-word') && document.getElementById('terminal-status-word').textContent.length > 0`, 'the word for a team agent', 8000);
        for (const fs of ['', '32px']) {
            await ev(`document.documentElement.style.fontSize = ${JSON.stringify(fs)}; true`); await settle(ev, 500); // sleep-ok: the header reflows
            const g = await ev(`(() => { const R = id => { const e = document.getElementById(id); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; }, w = R('terminal-status-word'), hit = (a, b) => !!a && !!b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1; const r = x => x && [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)]; return { word: r(w), label: r(R('terminal-header-label')), context: r(R('terminal-header-context')), dot: r(R('terminal-status-dot')), overLabel: hit(w, R('terminal-header-label')), overContext: hit(w, R('terminal-header-context')), overDot: hit(w, R('terminal-status-dot')) }; })()`);
            assert.ok(!g.overLabel && !g.overContext && !g.overDot, `text ${fs || '100%'}: the word is over neither the name, its team nor the dot: ` + JSON.stringify(g));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
