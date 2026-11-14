// #16701: the reply's Copy icon in prose mode on a phone must not overlap the next row.
// At rest (no hover, no tap) the button is hidden; after a tap on the reply it appears
// inside the bubble, not below it. Widths: 390 px (iPhone SE) and 454 px (iPhone 14 Plus).
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const MARKUP = `
<div id="zz-copy" class="chat-messages chat-prose" style="position:fixed;left:0;top:60px;width:100%;z-index:9999;background:var(--bg-primary);padding:12px">
  <div class="chat-bubble assistant" id="zz-reply">
    <div class="message-text">A reply whose copy icon used to sit below the bubble and cover the next row.</div>
    <button type="button" class="btn btn-quiet btn-icon btn-xs chat-copy-btn" title="Copy" aria-label="Copy message"><span class="material-icons" aria-hidden="true">content_copy</span></button>
  </div>
  <div class="chat-bubble assistant" id="zz-next">
    <div class="message-text">The next reply: the copy icon above must never cover me.</div>
  </div>
</div>`;

async function runAt(width, Page, Emulation, ev, install) {
    await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: true });
    await Emulation.setTouchEmulationEnabled({ enabled: true });
    await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
    await ev(`(() => { document.getElementById('zz-copy')?.remove(); const d = document.createElement('div'); d.innerHTML = ${JSON.stringify(MARKUP.trim())}; document.body.append(d.firstElementChild); })()`);

    // at rest: the button is hidden (opacity 0 or very low, pointer-events none)
    const atRest = await ev(`(() => {
        const btn = document.querySelector('#zz-reply .chat-copy-btn');
        const next = document.getElementById('zz-next');
        const s = getComputedStyle(btn);
        const bRect = btn.getBoundingClientRect();
        const nRect = next.getBoundingClientRect();
        const overlap = Math.min(bRect.right, nRect.right) - Math.max(bRect.left, nRect.left) > 1
                     && Math.min(bRect.bottom, nRect.bottom) - Math.max(bRect.top, nRect.top) > 1;
        return { opacity: parseFloat(s.opacity), pe: s.pointerEvents, overlap, bottom: Math.round(bRect.bottom), nextTop: Math.round(nRect.top) };
    })()`);
    assert.ok(atRest.opacity < 0.1, `${width}px at rest: hidden (opacity ${atRest.opacity})`);
    assert.equal(atRest.pe, 'none', `${width}px at rest: not clickable`);
    assert.equal(atRest.overlap, false, `${width}px at rest: no overlap with next row: ${JSON.stringify(atRest)}`);

    // tap the reply bubble: the copy button appears
    await ev(`(() => { document.getElementById('zz-reply').click(); })()`);
    const afterTap = await ev(`(() => {
        const btn = document.querySelector('#zz-reply .chat-copy-btn');
        const reply = document.getElementById('zz-reply');
        const next = document.getElementById('zz-next');
        const s = getComputedStyle(btn);
        const bRect = btn.getBoundingClientRect();
        const rRect = reply.getBoundingClientRect();
        const nRect = next.getBoundingClientRect();
        const insideBubble = bRect.top >= rRect.top && bRect.bottom <= rRect.bottom;
        const overlap = Math.min(bRect.right, nRect.right) - Math.max(bRect.left, nRect.left) > 1
                     && Math.min(bRect.bottom, nRect.bottom) - Math.max(bRect.top, nRect.top) > 1;
        return { opacity: parseFloat(s.opacity), pe: s.pointerEvents, insideBubble, overlap, revealed: reply.classList.contains('copy-revealed') };
    })()`);
    assert.ok(afterTap.opacity >= 0.9, `${width}px after tap: visible (opacity ${afterTap.opacity})`);
    assert.notEqual(afterTap.pe, 'none', `${width}px after tap: clickable`);
    assert.equal(afterTap.revealed, true, `${width}px after tap: copy-revealed class on bubble`);
    assert.equal(afterTap.insideBubble, true, `${width}px after tap: button is inside the bubble, not below it`);
    assert.equal(afterTap.overlap, false, `${width}px after tap: no overlap with next row`);

    // tap elsewhere: the reveal clears
    await ev(`(() => { document.body.click(); })()`);
    const afterClear = await ev(`(() => {
        const reply = document.getElementById('zz-reply');
        const btn = reply.querySelector('.chat-copy-btn');
        const s = getComputedStyle(btn);
        return { opacity: parseFloat(s.opacity), revealed: reply.classList.contains('copy-revealed') };
    })()`);
    assert.ok(afterClear.opacity < 0.1, `${width}px after clear: hidden again (opacity ${afterClear.opacity})`);
}

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 454]) await runAt(w, Page, Emulation, ev, install);
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
