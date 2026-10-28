// The phone's menu (the hamburger beside the view's name) on a short phone (#10767, coral-hub's report: 320x568 and 390x568, its last item, Sign out, spanned y=554-598 with 30 px off the screen, and the menu did not scroll): the menu is
// never taller than the room under its button, it scrolls inside, and every item can be brought on screen. Local dashboard here (its menu is the same one the Hub path fills); the Hub's extra items only make it taller.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[320, 568], [390, 568]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`document.getElementById('top-menu-btn').click(); true`);
            await waitFor(`!document.getElementById('nav-more-menu').hidden && document.getElementById('nav-more-menu').getClientRects().length > 0`, `${w}x${h}: the menu opens`, 5000);
            // make it the menu a Hub user has: more items than the room (the Hub's Account, Servers and Sign out items come after the settings'), so the test does not depend on what this dashboard lists (a Hub's menu also holds Account, Servers and Sign out)
            await ev(`(() => { const m = document.getElementById('nav-more-menu'); for (let i = 0; i < 6; i++) { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item nav-more-item'; b.setAttribute('role', 'menuitem'); b.textContent = i === 5 ? 'Sign out' : 'Extra item ' + i; m.append(b); } return true; })()`);
            const g = await ev(`(() => { const m = document.getElementById('nav-more-menu'), r = m.getBoundingClientRect(), cs = getComputedStyle(m); return { bottom: r.bottom, vh: innerHeight, overflowY: cs.overflowY, scrolls: m.scrollHeight > m.clientHeight + 1, top: r.top }; })()`);
            if (g.bottom > g.vh + 0.5) problems.push(`${w}x${h}: the menu ends at ${Math.round(g.bottom)} on a ${g.vh} px screen`);
            if (g.scrolls && !/auto|scroll/.test(g.overflowY)) problems.push(`${w}x${h}: the menu is taller than its room and does not scroll (overflow-y ${g.overflowY})`);
            const last = await ev(`(() => { const m = document.getElementById('nav-more-menu'), items = [...m.querySelectorAll('.nav-more-item')].filter(i => i.getClientRects().length), l = items[items.length - 1]; l.scrollIntoView({ block: 'nearest' }); const r = l.getBoundingClientRect(); return { text: l.textContent.trim(), bottom: r.bottom, top: r.top, vh: innerHeight }; })()`);
            if (last.bottom > last.vh + 0.5 || last.top < 0) problems.push(`${w}x${h}: the last item (${last.text}) cannot be brought on screen (${Math.round(last.top)} to ${Math.round(last.bottom)} of ${last.vh})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the top bar menu on a short phone:\n  ' + problems.join('\n  '));
    console.log('PASS the top bar menu fits a short phone and scrolls');
})().catch(e => { console.error(e); process.exit(1); });
