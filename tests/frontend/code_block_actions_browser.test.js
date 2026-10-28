// A code block in a chat message shows Copy at rest and a way to wrap its lines (#10533 point 1, the Desktop tester): Copy was drawn only on hover, so a keyboard or touch screen never saw it, a long line was cut and scrolled
// with no hint, and there was no way to wrap. Now: Copy is visible at rest; "Wrap lines" toggles the block; a block with a line that scrolls says so ("Scrolls sideways") until it is wrapped.
// The transcript renderer into a test box, 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`import((window.__coralStatic || '/static/') + 'live_chat.js').then(m => { window.__lc = m; return true; })`);
        const LONG = 'const answer = [' + Array.from({ length: 60 }, (_, i) => `'item-number-${i}'`).join(', ') + '];';
        const msg = '```js\n' + LONG + '\nconst short = 1;\n```\n\nand a short one:\n\n```\nls -la\n```';
        await ev(`(() => { document.getElementById('cb-box')?.remove(); const b = document.createElement('div'); b.id = 'cb-box'; b.className = 'chat-messages chat-prose'; b.style.cssText = 'position:absolute;left:0;top:0;width:700px;height:600px;overflow:auto;background:var(--bg-primary);z-index:99999;padding:12px'; document.body.appendChild(b); return true; })()`);
        await ev(`window.__lc.renderTranscript(${JSON.stringify([{ type: 'user', content: 'show me' }, { type: 'assistant', text: msg, content: msg }])}, document.getElementById('cb-box'), 'claude')`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the buttons and the scroll hint are drawn a frame after the block
        const state = () => ev(`[...document.querySelectorAll('#cb-box .code-block')].map(b => { const copy = b.querySelector('.code-copy-btn'), wrap = b.querySelector('.code-wrap-btn'), hint = b.querySelector('.code-scroll-hint'), pre = b.querySelector('pre'); return { copyOpacity: copy ? Number(getComputedStyle(copy).opacity) : null, wrapName: wrap && wrap.getAttribute('aria-label'), wrapPressed: wrap && wrap.getAttribute('aria-pressed'), hint: !!hint && hint.getClientRects().length > 0, hintText: hint && hint.textContent.trim(), scrolls: Math.max(pre.scrollWidth - pre.clientWidth, (pre.querySelector('code') || pre).scrollWidth - (pre.querySelector('code') || pre).clientWidth) > 1, wrapped: b.classList.contains('code-wrapped') }; })`);
        let s = await state();
        assert.equal(s.length, 2, 'two code blocks');
        assert.ok(s.every(b => b.copyOpacity >= 0.5), 'Copy is drawn at rest, not only on hover: ' + JSON.stringify(s));
        assert.ok(s.every(b => b.wrapName === 'Wrap lines' && b.wrapPressed === 'false'), 'each block has a Wrap lines toggle: ' + JSON.stringify(s));
        assert.ok(s[0].scrolls && s[0].hint && /Scrolls sideways/.test(s[0].hintText), 'the long block says it scrolls: ' + JSON.stringify(s[0]));
        assert.ok(!s[1].scrolls && !s[1].hint, 'a short block has no hint: ' + JSON.stringify(s[1]));
        await ev(`document.querySelector('#cb-box .code-block .code-wrap-btn').click(); true`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the block reflows
        s = await state();
        assert.ok(s[0].wrapped && s[0].wrapPressed === 'true' && !s[0].scrolls && !s[0].hint, 'wrapped: its lines wrap, nothing scrolls, no hint: ' + JSON.stringify(s[0]));
        await ev(`document.querySelector('#cb-box .code-block .code-wrap-btn').click(); true`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the block reflows
        s = await state();
        assert.ok(!s[0].wrapped && s[0].scrolls && s[0].hint, 'toggled back: it scrolls and says so again: ' + JSON.stringify(s[0]));
        console.log('PASS code blocks: Copy at rest, Wrap lines, a hint when a line scrolls');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
