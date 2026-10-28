// No desktop hover tooltips on a touch screen (Mobile pass 30, #10385, #10388): a tap leaves the pointer "hovering", and the composer's CSS tooltips ("Sends the text from the input box below to the terminal") stayed up over Send
// options. With a coarse pointer the tooltip never draws: the forced :hover state of Send, Enter and the mode buttons has no ::after content. A phone in landscape, 844 x 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width), bottom: Math.round(r.bottom) }; })()`);
    const open = async (h = 390) => {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 844, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__m.add('coral-go', 'm', 8, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the chat', 10000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the page settles
    };
    try {
        await open();
        await client.DOM.enable(); await client.CSS.enable();
        const { root } = await client.DOM.getDocument({ depth: 0 });
        for (const sel of ['.btn-send', '.btn-nav[data-tooltip]', '.btn-enter']) {
            const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector: sel });
            if (!nodeId) continue;
            await client.CSS.forcePseudoState({ nodeId, forcedPseudoClasses: ['hover'] });
            const after = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const c = getComputedStyle(e, '::after').content; return c; })()`);
            check(after === 'none' || after === 'normal' || after === '""' || after === '', `${sel}: a tap's hover draws no tooltip (its ::after content is ${after})`);
            await client.CSS.forcePseudoState({ nodeId, forcedPseudoClasses: [] });
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'tooltips:\n  ' + problems.join('\n  '));
    console.log('PASS tooltips');
})().catch(e => { console.error(e); process.exit(1); });
