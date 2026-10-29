// The phone chat's scroller has no 2 px of sideways overflow (#10923, the dim strip above the composer: a 16 px horizontal scrollbar from the Copy button hanging 4 px past its bubble), found rather than hidden:
// scrollWidth equals clientWidth, the overflow is not clipped (overflow-x is still auto), and a long code block, a wide table and a long unbroken URL scroll inside themselves or wrap, none of them making the
// scroller scroll sideways. 390 px, touch; the isolated dev server's mocked chat.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: layout settles
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('scr', 'S', 8, { sleeping: false }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await select('scr');
        await waitFor(`window.__rendered && window.__rendered().length >= 4`, 'the chat', 15000); await sleep(800); // sleep-ok: the chat settles
        const base = await ev(`(() => { const c = document.getElementById('live-history-messages'); return { sw: c.scrollWidth, cw: c.clientWidth, ox: getComputedStyle(c).overflowX, bar: c.offsetHeight - c.clientHeight }; })()`);
        assert.ok(base.sw === base.cw && base.bar === 0, 'the scroller has no sideways overflow: ' + JSON.stringify(base));
        assert.equal(base.ox, 'auto', 'and nothing is hidden to get there: ' + JSON.stringify(base));
        // wide content inside a message scrolls or wraps inside itself
        const wide = await ev(`(() => { const c = document.getElementById('live-history-messages'), t = c.querySelector('.chat-bubble.assistant .message-text');
            t.insertAdjacentHTML('beforeend', '<pre id="zz-code"><code>' + 'const veryLongLine = ' + 'x'.repeat(200) + ';</code></pre><div style="overflow-x:auto" id="zz-tbl"><table><tr><td>' + 'wide cell '.repeat(30) + '</td></tr></table></div><p id="zz-url">https://example.com/' + 'a'.repeat(160) + '</p>');
            const o = id => { const e = document.getElementById(id); return { sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX, ow: getComputedStyle(e).overflowWrap }; };
            return { sc: { sw: c.scrollWidth, cw: c.clientWidth }, code: o('zz-code'), tbl: o('zz-tbl'), url: o('zz-url') }; })()`);
        assert.ok(wide.code.sw > wide.code.cw && wide.code.ox === 'auto', 'a long code block scrolls inside itself: ' + JSON.stringify(wide.code));
        assert.ok(wide.tbl.sw <= wide.tbl.cw || wide.tbl.ox === 'auto', 'a wide table wraps or scrolls inside itself: ' + JSON.stringify(wide.tbl));
        assert.ok(wide.sc.sw <= wide.sc.cw, 'none of them makes the scroller scroll sideways (a long unbroken URL wraps or is clipped inside its message): ' + JSON.stringify(wide));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
