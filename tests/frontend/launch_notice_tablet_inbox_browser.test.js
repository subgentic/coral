// A cold /inbox load at 601-767 px (#16557, QA Engineer 2's note on #16460): theme_init.js counts a phone as <= 600 px, the layout's phone breakpoint is 767 px. At 700 px the Inbox is the drawer layout, with no
// pane heading, so the launch notice is the strip under the top bar there (launch_disclosure.js placeNotice finds no heading to sit under) and its room is the strip's too (.layout margin): the two agree on WHERE.
// What differed was HOW MUCH: the first cold load (no hint yet) reserved the wide window's 73 px for a notice that is 53 px there, so the page moved 20 px when it arrived. The content under the banners is followed frame by frame, as launch_notice_no_jump does; the notice's read is held so it lands after first paint.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const HOLD = `(() => { const f = window.fetch; window.fetch = (u, o) => /\\/api\\/launch-disclosure(\\?|$)/.test(String((u && u.url) || u)) && (!o || !o.method || o.method === 'GET') ? new Promise(r => setTimeout(r, 700)).then(() => f(u, o)) : f(u, o); })()`; // sleep-ok: the read is held on purpose
const TRACK = `(() => { const t = window.__jump = { tops: [], noticeAt: -1 };
    const content = () => [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100);
    const tick = () => { const n = document.getElementById('launch-disclosure-banner'), c = content();
        if (c) { const hd = document.querySelector('header.top-bar'), au = document.getElementById('local-auth-banner'); t.tops.push(Math.round((c.getBoundingClientRect().top - (hd ? hd.getBoundingClientRect().bottom : 0) - (au ? au.getBoundingClientRect().height : 0)) * 10) / 10); }
        if (n && c && t.noticeAt < 0 && n.getBoundingClientRect().height > 0) t.noticeAt = t.tops.length;
        if (t.noticeAt < 0 || t.tops.length < t.noticeAt + 3) requestAnimationFrame(tick); /* raf-ok: the tracker samples every frame itself, in the page */ };
    requestAnimationFrame(tick); /* raf-ok: as above */ })();`;

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + require('./helpers/launch_notice_agent').PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        await ev(`fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
        await ev(`try { localStorage.removeItem('coral-launch-notice'); } catch (e) {} true`);
        for (const pass of [1, 2]) {
            const ids = [HOLD, TRACK].map(source => Page.addScriptToEvaluateOnNewDocument({ source }));
            const idl = (await Promise.all(ids)).map(i => i.identifier);
            await Page.navigate({ url: BASE + '/inbox/needs' }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3`, `pass ${pass}: the notice on a cold 700 px load of /inbox/needs`, 15000);
            const j = await ev(`window.__jump`), spread = Math.max(...j.tops) - Math.min(...j.tops);
            const where = await ev(`(() => { const n = document.getElementById('launch-disclosure-banner'); return { inPane: n.parentElement.id === 'group-table-view', underBar: !!n.previousElementSibling && (n.previousElementSibling.id === 'local-auth-banner' || n.previousElementSibling.tagName === 'HEADER') }; })()`);
            assert.ok(spread <= 3, `pass ${pass}: the page under the notice stays put while it arrives (moved ${spread} px: ${JSON.stringify([...new Set(j.tops)])})`);
            assert.ok(where.underBar && !where.inPane, `pass ${pass}: at 700 px the notice is the strip under the top bar: ${JSON.stringify(where)}`);
            for (const id of idl) await Page.removeScriptToEvaluateOnNewDocument({ identifier: id });
        }
        console.log('launch_notice_tablet_inbox: ok');
    } finally { await guard.restore(); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
