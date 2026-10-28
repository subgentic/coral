// Banners never cover what a person is using (#10194, Beta #10169 and Mobile #10188 on #10068): the "Turn on alerts" offer and a needs-input toast stay clear of the composer's Send, the agent's header
// and the top bar, a click on Send lands on Send, and an open menu is never under a banner. At 1280 and at 390. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const rects = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, id: e.id || e.className }; })`);
    const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('alpha', 'A', 6, { sleeping: false }); true`);
            await ev(`window.selectLiveSession('alpha', 'claude', 'alpha-id'); true`);
            await waitFor(`!!document.getElementById('live-history-messages') && document.querySelectorAll('[data-on-click="cmd-send"]').length > 0`, 'the chat and its composer');
            await ev(`(() => { function N() {} Object.defineProperty(N, 'permission', { get: () => 'default' }); N.requestPermission = async () => 'granted'; window.Notification = N; localStorage.clear(); return true; })()`);
            await ev(`import(${MOD} + 'alerts_offer.js').then(m => m.offerAlertsAfterLaunch())`);
            await ev(`import(${MOD} + 'utils.js').then(m => m.showNotificationToast('alpha', 'Wants to run something', () => {}))`);
            await waitFor(`document.querySelectorAll('#notices .toast, #notices .notification-toast, #alerts-offer-banner').length >= 2`, 'both banners');
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the banners slide in for 0.3 s; their place is read once they have stopped
            const banners = await rects('#notices .toast, #notices .notification-toast, #alerts-offer-banner'); // the alerts offer is a strip in the page's flow now (#10248), the needs-input toast still floats
            const send = await rects('[data-on-click="cmd-send"]');
            const head = await rects('#live-session-view .terminal-header');
            const bar = await rects('header.top-bar');
            assert.ok(send.length > 0 && head.length > 0, `${at}: the composer's Send and the agent's header are on screen`);
            for (const b of banners) for (const [name, rs] of [['Send', send], ['the agent header', head], ['the top bar', bar]]) for (const r of rs) assert.ok(!hit(b, r), `${at}: a banner ${JSON.stringify(b)} covers ${name} ${JSON.stringify(r)}`);
            for (const b of banners) assert.ok(b.l >= 0 && b.t >= 0 && b.r <= w && b.b <= h, `${at}: a banner is wholly on screen ${JSON.stringify(b)}`);
            // a click meant for Send reaches Send
            for (const s of send) {
                const top = await ev(`(() => { const e = document.elementFromPoint(${s.l + (s.r - s.l) / 2}, ${s.t + (s.b - s.t) / 2}); return e ? !!e.closest('[data-on-click="cmd-send"]') : false; })()`);
                assert.ok(top, `${at}: what is at Send's centre is Send`);
            }
            // an open menu is never under a banner: open one (the hamburger on a phone; on a desktop the first control that says it opens a menu) and it must open
            await ev(`(() => { const hb = document.getElementById('top-menu-btn'); const b = hb && getComputedStyle(hb).display !== 'none' ? hb : [...document.querySelectorAll('[aria-haspopup="menu"]')].find(x => x.getClientRects().length && !x.closest('#notices')); if (b) b.click(); return true; })()`);
            const menuOpen = await ev(`[...document.querySelectorAll('.menu:not([hidden])')].some(m => m.getClientRects().length > 0)`);
            assert.ok(menuOpen, `${at}: a menu opened (this test is about banners under an open menu)`);
            await waitFor(`document.getElementById('notices').style.visibility === 'hidden'`, 'the banners step aside while the menu is open');
            const items = await rects('.menu:not([hidden]) .menu-item');
            assert.ok(items.length > 0, `${at}: the menu has entries`);
            for (const it of items) {
                const covered = await ev(`(() => { const e = document.elementFromPoint(${it.l + (it.r - it.l) / 2}, ${it.t + (it.b - it.t) / 2}); return !(e && e.closest('.menu')); })()`);
                assert.ok(!covered, `${at}: a banner covers a menu entry ${JSON.stringify(it)}`);
            }
            // closed by anything but a click or a key (here: the code that owns it), the banners come back on their own
            await ev(`document.querySelectorAll('.menu').forEach(m => { m.hidden = true; }); true`);
            await waitFor(`document.getElementById('notices').style.visibility !== 'hidden'`, 'the banners are back once the menu is closed, whatever closed it');
            console.log(`PASS ${at}: banners clear of Send, the agent header and the top bar; Send is hittable; an open menu is not covered`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
