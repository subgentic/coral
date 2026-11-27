// The launch notice does not push the agent list down when the first list is empty and the agents come after it (#21962, the notice came 7-80 ms after the first phone list was drawn and moved it 53 px under a tap).
// The first live list answers at once with no agent; the agent arrives 1.4 s later and the notice comes with it. The reserved row is kept until the notice's own decision is made (shown), not given back for 'no local agent yet'.
// 1280 and 390 px; the room under the banners (the app's container) and the first agent row's top do not move from the first frame the row is drawn, and the hint is still there.
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
    // the feed says 'no agents' for 1.4 s, then the agent arrives
    const SLOW = `(() => { const a = window.__m && window.__m.agents; if (!a) return; window.__saved = { ...a }; for (const k of Object.keys(a)) delete a[k]; })();`; // the first list has no agent
    // the agent arrives after that list is drawn: the feed's next update carries it (the notice comes with it)
    const ARRIVE = `import((window.__coralStatic || '/static/') + 'websocket.js').then(m => { Object.assign(window.__m.agents, window.__saved); m.handleCoralMessage({ type: 'coral_update', sessions: Object.values(window.__m.agents).map(x => window.__m.entry(x)) }); return true; })`;
    const TRACK = `(() => { const t = window.__jump = { tops: [], noticeAt: -1 };
        const content = () => [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100);
        const rowTop = () => { const r = document.querySelector('.session-group-item'); return r ? Math.round(r.getBoundingClientRect().top * 10) / 10 : null; };
        t.rows = [];
        const tick = () => { const rt = rowTop(); if (rt !== null) t.rows.push(rt); const n = document.getElementById('launch-disclosure-banner'), c = content();
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
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`localStorage.removeItem('coral-launch-notice'); fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure())`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner')`, `${at}the unseen notice`, 10000);
            const hint = await ev(`localStorage.getItem('coral-launch-notice')`);
            check(/^[pd]\|\d+$/.test(hint || ''), `${at}the notice leaves a hint: ${JSON.stringify(hint)}`);
            extra = (await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + require('./helpers/launch_notice_agent').PRELOAD + SLOW + TRACK })).identifier;
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded');
            await waitFor(`!!document.getElementById('launch-notice-room') && !document.getElementById('launch-disclosure-banner')`, `${at}the first list is drawn empty and the reserved row is still there`, 8000);
            await ev(ARRIVE);
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3`, `${at}the notice on a load with an empty first list`, 20000);
            const j = await ev(`window.__jump`), all = j.tops, spread = Math.max(...all) - Math.min(...all);
            check(j.rows.length >= 1 && Math.max(...j.rows) - Math.min(...j.rows) <= 1.5, `${at}the first agent row does not move from its first drawn frame (tops ${JSON.stringify([...new Set(j.rows)])})`);
            check(j.noticeAt >= 1 && spread <= 1.5, `${at}the room under the banners stays put with the agent 1.4 s after an empty first list (it moved ${spread} px over ${all.length} frames; before the notice ${JSON.stringify([...new Set(all.slice(0, j.noticeAt))])}, after ${JSON.stringify([...new Set(all.slice(j.noticeAt))])})`);
            check(/^[pd]\|\d+$/.test(await ev(`localStorage.getItem('coral-launch-notice')`) || ''), `${at}the hint is still there for the next load`);
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!document.getElementById('launch-disclosure-banner')`, `${at}the notice dismissed`, 8000);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_empty_then_agents_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
