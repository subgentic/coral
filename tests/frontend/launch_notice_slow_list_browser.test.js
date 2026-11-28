// The launch notice does not move the page when the first live list is slow (#19411, launch_notice_no_jump retry-passed in batch gates, the room under the banners moved 73 px at 1280).
// The notice is read after first paint; when its answer came before the first list of agents, 'no local agent yet' was taken for 'no agent': the reserved row and the hint were given back, and the notice arrived into no room.
// Here the list answers 1.5 s late on the later load (a loaded machine, or a slow start), and the feed has no agent until then. 1280 and 390 px; the room under the banners (the app's container, frame by frame) does not move and the hint is still there.
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
    // the first list and the feed are late: the feed says 'no agents' for 1.4 s (a loaded machine: the first list of agents lands after the notice was read), the first list answers at 1.5 s with the agent in it
    const SLOW = `(() => { const a = window.__m && window.__m.agents; if (!a) return; const saved = { ...a }; for (const k of Object.keys(a)) delete a[k];
        setTimeout(() => Object.assign(window.__m.agents, saved), 1400); // sleep-ok: the late agent is the fixture
        const f = window.fetch; window.fetch = (u, o) => /\\/api\\/sessions\\/live/.test(String(u)) ? new Promise(r => setTimeout(r, 1500)).then(() => f(u, o)) : f(u, o); })();`; // sleep-ok: the late list is the fixture
    const TRACK = `(() => { const t = window.__jump = { tops: [], noticeAt: -1 };
        const content = () => [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100);
        const tick = () => { const n = document.getElementById('launch-disclosure-banner'), c = content();
            if (c) { const hd = document.querySelector('header.top-bar'), au = document.getElementById('local-auth-banner'); t.tops.push(Math.round((c.getBoundingClientRect().top - (hd ? hd.getBoundingClientRect().bottom : 0) - (au ? au.getBoundingClientRect().height : 0)) * 10) / 10); }
            if (n && c && t.noticeAt < 0 && n.getBoundingClientRect().height > 0) t.noticeAt = t.tops.length;
            if (t.noticeAt < 0 || t.tops.length < t.noticeAt + 3) requestAnimationFrame(tick); /* raf-ok: the tracker samples every frame itself, in the page, from the first one */ };
        requestAnimationFrame(tick); /* raf-ok: as above */ })();`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + require('./helpers/launch_notice_agent').PRELOAD });
        let extra = null;
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            if (extra) await Page.removeScriptToEvaluateOnNewDocument({ identifier: extra }); extra = null;
            await Page.navigate({ url: BASE + '/?test_agent=1' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`localStorage.removeItem('coral-launch-notice'); fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure())`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner')`, `${at}the unseen notice`, 10000);
            const hint = await ev(`localStorage.getItem('coral-launch-notice')`);
            check(/^[pd]\|\d+$/.test(hint || ''), `${at}the notice leaves a hint: ${JSON.stringify(hint)}`);
            extra = (await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + require('./helpers/launch_notice_agent').PRELOAD + SLOW + TRACK })).identifier;
            await Page.navigate({ url: BASE + '/?test_agent=1' }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3`, `${at}the notice on a load with a slow list`, 20000);
            const j = await ev(`window.__jump`), all = j.tops, spread = Math.max(...all) - Math.min(...all);
            check(j.noticeAt >= 1 && spread <= 1.5, `${at}the room under the banners stays put with the list 1.5 s late (it moved ${spread} px over ${all.length} frames; before the notice ${JSON.stringify([...new Set(all.slice(0, j.noticeAt))])}, after ${JSON.stringify([...new Set(all.slice(j.noticeAt))])})`);
            check(/^[pd]\|\d+$/.test(await ev(`localStorage.getItem('coral-launch-notice')`) || ''), `${at}the hint is still there for the next load`);
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!document.getElementById('launch-disclosure-banner')`, `${at}the notice dismissed`, 8000);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_slow_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
