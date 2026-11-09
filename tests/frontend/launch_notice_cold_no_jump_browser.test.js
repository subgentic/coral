// The launch notice does not move the page on the FIRST load of a profile either (#14935, after #14835's hint that only helped the second): the page the server renders says the notice is unseen, and its typical room is reserved before first paint
// with no stored hint. A cold profile (no hint), the notice's read held 700 ms so it surely lands after first paint: what sits under the banners is at the same place before and after it appears (within 3 px: a typical height, not the exact one).
// And a notice that is read reserves nothing on a cold load. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

const HOLD = `(() => { const f = window.fetch; window.fetch = (u, o) => /\\/api\\/launch-disclosure(\\?|$)/.test(String((u && u.url) || u)) && (!o || !o.method || o.method === 'GET') ? new Promise(r => setTimeout(r, 700)).then(() => f(u, o)) : f(u, o); })()`; // sleep-ok: the notice's read is held on purpose, so it lands after first paint

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    // the tracker runs from the start of every document: the element right under the sign-in banner (or the top bar), its top at every frame, and when the notice is on screen
    const TRACK = `(() => { const t = window.__jump = { tops: [], noticeAt: -1, frames: 0 };
        const content = () => [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100);
        const tick = () => { t.frames++; const n = document.getElementById('launch-disclosure-banner'), c = content();
            // the room the notice takes (or has reserved): the content's top under the top bar, less the sign-in banner's own height (that banner arrives late too, and is not this test's subject)
            if (c) { const hd = document.querySelector('header.top-bar'), au = document.getElementById('local-auth-banner'); t.tops.push(Math.round((c.getBoundingClientRect().top - (hd ? hd.getBoundingClientRect().bottom : 0) - (au ? au.getBoundingClientRect().height : 0)) * 10) / 10); }
            if (n && c && t.noticeAt < 0 && n.getBoundingClientRect().height > 0) t.noticeAt = t.tops.length;
            if (t.noticeAt < 0 || t.tops.length < t.noticeAt + 3) requestAnimationFrame(tick); /* raf-ok: the tracker samples every frame itself, in the page, from the first one */ };
        requestAnimationFrame(tick); /* raf-ok: as above */ })();`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            // 1. cold and unseen: no hint, the server's page says unseen, the notice's read is held
            await ev(`fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await ev(`try { localStorage.removeItem('coral-launch-notice'); } catch (e) {} true`);
            const ids = [(await Page.addScriptToEvaluateOnNewDocument({ source: HOLD })).identifier, (await Page.addScriptToEvaluateOnNewDocument({ source: TRACK })).identifier];
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            check(await ev(`document.documentElement.hasAttribute('data-launch-notice')`), `${at}the room is reserved before first paint on a cold load (the server said the notice is unseen)`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3`, `${at}the notice on a cold load`, 15000);
            const j = await ev(`window.__jump`);
            const spread = Math.max(...j.tops) - Math.min(...j.tops);
            check(j.noticeAt >= 1 && spread <= 3, `${at}the content under the banners stays put on a COLD load while the notice arrives (it moved ${spread} px over ${j.tops.length} frames: ${JSON.stringify([...new Set(j.tops)])})`);
            for (const id of ids) await Page.removeScriptToEvaluateOnNewDocument({ identifier: id });
            // 2. read: a cold load (no hint) reserves nothing
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!document.getElementById('launch-disclosure-banner')`, `${at}the notice dismissed`, 8000);
            await ev(`try { localStorage.removeItem('coral-launch-notice'); } catch (e) {} true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            check(await ev(`!document.documentElement.hasAttribute('data-launch-notice') && !document.getElementById('launch-notice-room')`), `${at}once it is read a cold load reserves nothing`);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_cold_no_jump_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
