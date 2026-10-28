// Stop sits apart from Send (Mobile pass 30, #10385, #10388): while the agent works the red Stop took the Send button's place right beside Send options, a mis-tap away from the options (or the other way). With Stop shown there is
// room (at least 12 px) between the options and it, and it keeps its 44 px. A phone in landscape, 844 x 390.
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
        await ev(`document.getElementById('mobile-send-btn').classList.add('is-stop'); document.getElementById('mobile-send-btn').setAttribute('data-on-click', 'cmd-stop'); true`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the layout follows
        const o = await rect('.mobile-send-options-btn'), s = await rect('#mobile-send-btn');
        check(o && s && s.left - (o.left + o.w) >= 12, `Stop is at least 12 px from Send options: ${JSON.stringify([o, s])}`);
        check(s && s.h >= 44 && s.w >= 44, `and it stays 44 px: ${JSON.stringify(s)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'stop_gap:\n  ' + problems.join('\n  '));
    console.log('PASS stop_gap');
})().catch(e => { console.error(e); process.exit(1); });
