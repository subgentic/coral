// #16754: on a phone with the keyboard open the ask dialog keeps Send reply in view. The footer (Close, Dismiss) was the sticky part, so with a long question Send scrolled out under it and the person saw only
// Close and Dismiss (Operator, Android Chrome on the Hub). The keyboard is simulated as Chrome on Android does (it shrinks the layout viewport): 390 x 844 down to 390 x 360.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        const text = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: which of the two release plans should the team follow, and who signs it off?`).join('\n\n');
        await ev(`window.__replies = []; const real = window.fetch; window.fetch = (u, o = {}) => { if ((o.method || 'GET') === 'POST') { window.__replies.push(new URL(String(u), location.href).pathname); return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })); } return real(u, o); }; true`);
        await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.openAskDialog({ server: 'local', board: 'release', kind: 'ask', id: 41, asker: 'Lead', text: ${JSON.stringify(text)}, at: new Date().toISOString() }, () => {}))`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-send')`, 'the question is open');
        const probe = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'), s = d.querySelector('.inbox-ask-send'), r = s.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
            return { inView: r.top >= 0 && r.bottom <= innerHeight && r.height >= 44, hit: !!top && (top === s || s.contains(top)), vh: innerHeight, bottom: Math.round(r.bottom), disabled: s.disabled, scrolls: d.scrollHeight > d.clientHeight }; })()`);
        // the keyboard goes up: the layout is 360 px tall, and the reply box has the focus
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 360, deviceScaleFactor: 1, mobile: true });
        await ev(`document.querySelector('dialog.inbox-ask-dialog[open] textarea').focus(); document.querySelector('dialog.inbox-ask-dialog[open] textarea').value = 'Plan B'; document.querySelector('dialog.inbox-ask-dialog[open] textarea').dispatchEvent(new Event('input', { bubbles: true })); true`);
        await nextFrame(ev); await nextFrame(ev);
        let m = await probe();
        assert.equal(m.scrolls, true, 'the question is longer than the band the keyboard leaves (the test is about a dialog that scrolls)');
        assert.equal(m.inView, true, 'Send reply is inside the visible band, 44 px tall: ' + JSON.stringify(m));
        assert.equal(m.hit, true, 'nothing covers Send reply (a tap reaches it): ' + JSON.stringify(m));
        // scrolled to the very top and the very bottom of the question it stays in view
        for (const to of [0, 100000]) { await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').scrollTop = ${to}; true`); await nextFrame(ev); m = await probe(); assert.ok(m.inView && m.hit, `Send reply stays in view at scrollTop ${to}: ` + JSON.stringify(m)); }
        // and it is the first action: it comes before Close and Dismiss
        const order = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'), n = [...d.querySelectorAll('button')]; const at = t => n.findIndex(b => b.textContent.trim() === t); return { send: n.findIndex(b => b.classList.contains('inbox-ask-send')), close: at('Close'), dismiss: at('Dismiss, no reply') }; })()`);
        assert.ok(order.send >= 0 && order.send < order.close && order.send < order.dismiss, 'Send reply comes before Close and Dismiss: ' + JSON.stringify(order));
        await ev(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-send').click(); true`);
        await waitFor(`window.__replies.length > 0`, 'a tap on Send reply sends the reply');
        // the keyboard goes down: the footer is back where it was (the sticky one), the rows have their normal layout
        await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the dialog closes after the reply');
        console.log('PASS the ask dialog keeps Send reply in view and tappable with the keyboard open');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
