// The chat keeps its room while typing (Mobile pass 30, #10385, #10388): in landscape the top bar, the sign-in notice and the agent's header took about 140 px of 390 (and with the keyboard up the messages had 80 px of 200). With the
// message box focused the agent header folds away too (it returns on blur), so the chat has at least 120 px with the keyboard up and about three lines of messages with it down. 844 x 390, and 844 x 200 for the keyboard.
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
        const before = await rect('#live-history-messages');
        await ev(`document.getElementById('command-input').focus(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page folds
        const head = await rect('#live-session-view .terminal-header');
        check(!head, `while typing the agent header is folded away: ${JSON.stringify(head)}`);
        await Emulation.setDeviceMetricsOverride({ width: 844, height: 200, deviceScaleFactor: 1, mobile: true }); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the layout follows the keyboard
        const kb = await rect('#live-history-messages');
        check(kb && kb.h >= 110, `with the keyboard up the chat has at least 110 px: ${JSON.stringify(kb)}`);
        await Emulation.setDeviceMetricsOverride({ width: 844, height: 390, deviceScaleFactor: 1, mobile: true }); await ev(`document.getElementById('command-input').blur(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page unfolds
        const back = await rect('#live-session-view .terminal-header');
        check(!!back, 'the agent header is back when the box loses focus');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'fold:\n  ' + problems.join('\n  '));
    console.log('PASS fold');
})().catch(e => { console.error(e); process.exit(1); });
