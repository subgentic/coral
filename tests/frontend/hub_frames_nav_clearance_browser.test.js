// A Hub page in a frame meets the docked phone nav, with no gap above it (#13328, the Hub phone Tasks page: the workspace bar ended 95 px above the nav): Tasks and Saved are an .inbox-frame inside #group-table-view, Artifacts a frame
// in #artifacts-view, the Inbox a frame in #inbox-view (#13104). The frames are put in the real views (no Hub sign-in), the view is shown, and the gap between the frame's bottom and the nav's top is measured. 390 px, touch; at 200% text too.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const fs16 of [16, 32]) {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs16}px'; true`);
            for (const [view, host, direct] of [['group-table-view', 'group-table-view', false], ['artifacts-view', 'artifacts-view', true], ['inbox-view', 'inbox-view', true]]) {
                const tag = `${view} at ${fs16 === 32 ? '200% text' : '100%'}`;
                const gap = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'view_switch.js'); m.showView(${JSON.stringify(view)}); const h = document.getElementById(${JSON.stringify(host)}); document.querySelectorAll('.test-frame').forEach(f => f.remove());
                    const f = document.createElement('iframe'); f.className = 'inbox-frame test-frame'; ${view === 'inbox-view' ? "f.id = 'inbox-frame';" : ''} f.setAttribute('src', 'about:blank'); h.append(f);
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    const nav = document.querySelector('.phone-nav'); if (!nav || !nav.getClientRects().length) return { nav: false }; const n = nav.getBoundingClientRect(), r = f.getBoundingClientRect();
                    return { nav: true, gap: Math.round(n.top - r.bottom), frameH: Math.round(r.height), top: Math.round(r.top) }; })()`);
                check(`${tag}: the page has its docked nav`, gap.nav, JSON.stringify(gap));
                if (gap.nav) check(`${tag}: the frame ends at the nav (gap within 2 px of the nav's own clearance, not 95)`, gap.gap >= -2 && gap.gap <= 24, JSON.stringify(gap));
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Hub frames and the phone nav:\n  ' + problems.join('\n  '));
    console.log('PASS Hub frames (Tasks/Saved, Artifacts, Inbox) meet the docked nav with no 95 px gap');
})().catch(e => { console.error(e); process.exit(1); });
