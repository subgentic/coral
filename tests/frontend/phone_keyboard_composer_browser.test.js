// With a phone's on-screen keyboard open the composer sits on top of it, whole (#11060, the operator on Android Chrome through app.coralhub.dev: "the send button is hidden by the key card when typing"): the page follows what the keyboard leaves
// of the screen, so the text box, Send and Stop are inside the visible viewport and the last message stays above the composer; closing the keyboard gives the layout back with no jump. The keyboard is emulated by shrinking
// window.visualViewport (height, offsetTop) and its resize event, at 390 px, with touch. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const FAKE_VV = `(() => { const real = window.visualViewport; const t = new EventTarget(); const vv = { height: innerHeight, width: innerWidth, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, addEventListener: (...a) => t.addEventListener(...a), removeEventListener: (...a) => t.removeEventListener(...a), dispatchEvent: e => t.dispatchEvent(e) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    window.__kb = (h, top) => { vv.height = h; vv.offsetTop = top || 0; t.dispatchEvent(new Event('resize')); }; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: FAKE_VV });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('kb-agent', 'A', 14, { sleeping: false, session_id: 'kb-id' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'kb-agent')`, 'the agent', 10000);
        await ev(`window.selectLiveSession('kb-agent', 'claude', 'kb-id', 'local'); true`);
        await waitFor(`!!document.querySelector('#command-pane') && document.getElementById('command-input')?.getClientRects().length > 0`, 'the composer', 10000);
        const geo = () => ev(`(() => { const vv = window.visualViewport, top = vv.offsetTop, bottom = top + vv.height, box = e => { if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom) }; };
            const q = s => document.querySelector(s), msgs = q('#live-history-messages') || q('.chat-scroll') || q('#pane-capture'), last = msgs && [...msgs.querySelectorAll('.chat-bubble')].pop();
            return { visible: [Math.round(top), Math.round(bottom)], input: box(q('#command-input')), send: box(q('.mobile-send-btn')), opts: box(q('.mobile-send-options-btn')), pane: box(q('#command-pane')), last: box(last), body: Math.round(document.body.getBoundingClientRect().height) }; })()`);
        assert.match(await ev(`document.querySelector('meta[name=viewport]').content`), /interactive-widget=resizes-content/, 'the viewport meta asks Chrome on Android to resize the page for the keyboard');
        let g = await geo();
        const open = async (h, top) => { await ev(`(() => { const m = document.querySelector('#live-history-messages .chat-bubble:last-child') || [...document.querySelectorAll('.chat-bubble')].pop(); let e = m; while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement; if (e) e.scrollTop = e.scrollHeight; return true; })()`); await ev(`document.getElementById('command-input').focus(); window.__kb(${h}, ${top}); true`); await waitFor(`Math.round(document.body.getBoundingClientRect().height) <= ${h} + 1`, `the page follows a ${h} px viewport`, 4000); };
        for (const [h, top] of [[520, 0], [520, 120]]) { // a keyboard of 324 px; the second as Android scrolls the visual viewport to the caret
            await open(h, top);
            await waitFor(`(() => { const bs = [...document.querySelectorAll('.chat-bubble')]; const m = bs[bs.length - 1]; if (!m) return false; let e = m; while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement; if (e) e.scrollTop = e.scrollHeight; return m.getBoundingClientRect().bottom <= document.getElementById('command-pane').getBoundingClientRect().top + 1; })()`, `${h}/${top}: the last message is above the composer`, 4000);
            g = await geo();
            const inside = b => b && b.t >= g.visible[0] - 1 && b.b <= g.visible[1] + 1;
            assert.ok(inside(g.pane), `${h}/${top}: the whole composer is inside the visible viewport: ` + JSON.stringify(g));
            assert.ok(inside(g.input) && (inside(g.send) || g.send === null) && (inside(g.opts) || g.opts === null), `${h}/${top}: the text box, Send and the Send options are inside it: ` + JSON.stringify(g));
            assert.ok(!g.last || g.last.b <= g.pane.t + 1, `${h}/${top}: the last message stays above the composer: ` + JSON.stringify(g));
            await ev(`window.__kb(844, 0); true`);
            await waitFor(`Math.round(document.body.getBoundingClientRect().height) >= 843`, 'the layout comes back when the keyboard closes', 4000);
            const after = await geo();
            assert.ok(after.pane && after.pane.b <= 844 && after.pane.b >= 800, `${h}/${top}: the composer is back at the bottom with no jump: ` + JSON.stringify(after));
        }
        console.log('PASS the composer stays whole above the phone keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
