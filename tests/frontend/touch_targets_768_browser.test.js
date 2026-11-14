// Touch targets on a tablet in portrait (walk 61, #17308): at 768 x 1024 with a coarse pointer every visible control that is a button, link, field or summary is at least 44 x 44 CSS px, on the tabs of the dashboard
// (Agents, Inbox, Automations, Analytics) with the sign-in banner and the launch notice showing. Walk 61 measured: the sidebar toggle 30, Home and Settings 32, the banner close 32, Turn on alerts 32 tall, Search agents 36,
// notes, collapse-all and hide-sidebar 36, the sidebar chevrons and the health gear 24, the top nav 40. A mouse keeps the desktop sizes (touch_targets_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const UNDERSIZED = `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, summary, [onclick], [data-on-click]')) {
        // A checkbox or radio inside its label is tapped through the label.
        const hit = el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') ? el.closest('label') : el;
        const r = hit.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        // A dense glyph button (.btn-xs) keeps a 24 px box and is a 44 px target through its transparent ::after (#9332).
        // It counts only when it is invisible (no fill, no border) and centred on the control: an inset of -10px on a 24 px box, not any absolute pseudo-element.
        const after = getComputedStyle(el, '::after'); let w = r.width, h = r.height;
        const left = parseFloat(after.left), top = parseFloat(after.top), aw = parseFloat(after.width), ah = parseFloat(after.height);
        const invisible = after.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(after.borderTopWidth) === 0 && after.backgroundImage === 'none';
        const centred = Math.abs((left + aw / 2) - r.width / 2) <= 1 && Math.abs((top + ah / 2) - r.height / 2) <= 1;
        if (after.content !== 'none' && after.position === 'absolute' && invisible && centred) { w = Math.max(w, aw || 0); h = Math.max(h, ah || 0); }
        if (w >= 44 && h >= 44) continue;
        out.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + (el.id ? '#' + el.id : el.className) + ' [' + (el.getAttribute('aria-label') || el.title || el.textContent.trim()).slice(0, 30) + ']');
    }
    return out;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const out = {};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 768, height: 1024, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        for (const tab of ['agents', 'hub-inbox', 'automations', 'tokens']) {
            await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await ev(framesJs(20));
            out[tab] = await ev(UNDERSIZED);
        }
    } finally { await client.close(); }
    const all = Object.entries(out).flatMap(([tab, l]) => l.map(x => tab + ': ' + x));
    assert.deepEqual(all, [], 'controls under 44 px at 768 x 1024 touch:\n  ' + all.join('\n  '));
    console.log('PASS every control is 44 px at 768 x 1024 touch');
})().catch(e => { console.error(e.message); process.exit(1); });
