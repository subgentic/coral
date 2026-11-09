// The launch notice does not move the page when it arrives (#14835, since #14807 reads it after first paint): the first load that finds it unseen remembers that in this browser (a hint, never the authority: the server's
// 409 gate is), and every later load while it is unseen reserves its row before first paint, so what sits under the header is at the same place before and after the notice appears. Once it is read nothing is reserved.
// 1280 and 390 px. The content under the banners is (the app's own container) followed frame by frame from the first frame that has it until three frames after the notice is on screen.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

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
        let trackId = null;
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            if (trackId) await Page.removeScriptToEvaluateOnNewDocument({ identifier: trackId }); trackId = null;
            // 1. the first load: unseen, the hint is written when the notice is read
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`localStorage.removeItem('coral-launch-notice'); fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure())`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner')`, `${at}the unseen notice`, 10000);
            const hint = await ev(`localStorage.getItem('coral-launch-notice')`);
            check(/^[pd]\|\d+$/.test(hint || ''), `${at}the notice leaves a hint of its kind of screen and its height: ${JSON.stringify(hint)}`);
            // 1b. a later read with the details OPEN does not store the open height; a read that fails or answers nonsense leaves no empty reserved row (#14925, UI Accessibility's SHOULDs on #14835)
            await ev(`document.querySelector('#launch-disclosure-banner details').open = true; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure()).then(() => true)`);
            check(await ev(`localStorage.getItem('coral-launch-notice')`) === hint, `${at}a read with the details open leaves the hint as it was (${hint}), not the open height: ${JSON.stringify(await ev(`localStorage.getItem('coral-launch-notice')`))}`);
            await ev(`document.querySelector('#launch-disclosure-banner details').open = false; true`);
            for (const [name, stub] of [['a network failure', `Promise.reject(new TypeError('offline'))`], ['an answer that is not a notice', `Promise.resolve(new Response('{"id":""}', { status: 200, headers: { 'Content-Type': 'application/json' } }))`]]) {
                await ev(`(() => { document.documentElement.setAttribute('data-launch-notice', 'p'); const room = document.createElement('div'); room.id = 'launch-notice-room'; document.body.prepend(room); window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).includes('/api/launch-disclosure') && !String(u).includes('/ack') ? ${stub} : window.__realFetch(u, o); return true; })()`);
                await ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure()).then(() => { window.fetch = window.__realFetch; return true; })`);
                check(await ev(`!document.getElementById('launch-notice-room') && !document.documentElement.hasAttribute('data-launch-notice')`), `${at}${name} releases the reserved row`);
            }
            // 2. a later load while it is unseen: nothing under the banners moves when it arrives
            trackId = (await Page.addScriptToEvaluateOnNewDocument({ source: TRACK })).identifier;
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3`, `${at}the notice on a later load`, 15000);
            const j = await ev(`window.__jump`);
            const before = j.tops.slice(0, j.noticeAt), after = j.tops.slice(j.noticeAt);
            const all = j.tops, spread = Math.max(...all) - Math.min(...all);
            check(before.length >= 1 && spread <= 1.5, `${at}the content under the banners stays put while the notice arrives (the room under the banners moved ${spread} px over ${all.length} frames; before the notice ${JSON.stringify([...new Set(before)])}, after ${JSON.stringify([...new Set(after)])})`);
            // 3. read: the hint goes and nothing is reserved
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!document.getElementById('launch-disclosure-banner')`, `${at}the notice dismissed`, 8000);
            check(await ev(`localStorage.getItem('coral-launch-notice')`) === null, `${at}reading it removes the hint`);
            await Page.removeScriptToEvaluateOnNewDocument({ identifier: trackId }); trackId = null;
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            check(await ev(`!document.documentElement.hasAttribute('data-launch-notice') && !document.getElementById('launch-notice-room')`), `${at}once it is read nothing is reserved on the next load`);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_no_jump_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
