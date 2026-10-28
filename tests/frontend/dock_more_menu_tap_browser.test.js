// The agent side panel's More menu can be tapped on a phone (coral-hub's question, #10214): at Chrome 375 x 667 the item 'Agent UI' was reported as intercepted by an empty #agentic-panel-artifacts-view div over the menu. Every item of the menu is
// what a finger or a click at its own centre reaches (document.elementFromPoint), at 375 x 667 and 390 x 844, with the tab row scrolled so its edge fade is on (data-more, which makes the row a mask: #9377). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[375, 667], [390, 844]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`!!document.getElementById('agentic-tab-more') && document.getElementById('agentic-tab-more').getClientRects().length > 0`, `${w}: the dock's More tab`, 10000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the dock draws
            check(await ev(`!!document.querySelector('.agentic-state-tabs[data-more]')`), 'the tab row has its edge fade on (data-more), the condition in question');
            await ev(`document.getElementById('agentic-tab-more').click(); true`);
            await waitFor(`!document.getElementById('agentic-more-menu').hidden`, `${w}: the More menu is open`, 5000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            const hits = await ev(`[...document.querySelectorAll('#agentic-more-menu [role=menuitem]')].map(b => { const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y); return { tab: b.dataset.tab, w: Math.round(r.width), h: Math.round(r.height), inView: r.bottom <= innerHeight && r.top >= 0, ok: !!top && (top === b || b.contains(top)), over: top ? (top.id || top.className || top.tagName).toString().slice(0, 50) : null }; })`);
            check(hits.length >= 3, `the menu has its items: ${JSON.stringify(hits)}`);
            for (const x of hits) check(x.ok, `the "${x.tab}" item is what a tap at its centre reaches, not ${x.over}: ${JSON.stringify(x)}`);
            check(hits.every(x => x.inView), `every item is on the screen: ${JSON.stringify(hits.filter(x => !x.inView))}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the dock More menu on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the dock More menu is tappable on a phone');
})().catch(e => { console.error(e); process.exit(1); });
