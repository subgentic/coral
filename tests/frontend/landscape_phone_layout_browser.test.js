// A landscape phone (#12647, coral-hub's beta pass): at 844x390 and 915x412 with a coarse pointer the page is the phone's (phone_layout.js PHONE_QUERY), but the view list stayed
// the desktop's stacked column, about 1,000 px tall, and pushed the page's own pane below the fold on /inbox/needs and /agents. The list is the strip there, as at 390 wide, and the
// pane under it starts inside the screen. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[844, 390], [915, 412]]) {
            for (const route of ['/inbox/needs', '/agents']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
                await Page.navigate({ url: BASE + route }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                await ev(`for (const n of ['Ada', 'Bo', 'Cy']) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: 'team-a' }); true`);
                await waitFor(`(window.__qaState.liveSessions || []).length >= 3`, 'the agents', 10000);
                await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'), r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
                await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length >= 1 || ${JSON.stringify(route)} !== '/agents'`, 'the rows', 10000);
                const tag = `${w}x${h} ${route}`;
                const r = await ev(`(() => { const nav = document.querySelector('.view-list-nav'); const out = { coarse: matchMedia('(pointer: coarse)').matches, nav: null, vl: null };
                    const vl = [...document.querySelectorAll('.view-list')].find(e => e.getClientRects().length); if (vl) { const b = vl.getBoundingClientRect(); out.vl = { t: Math.round(b.top), h: Math.round(b.height), dir: nav ? getComputedStyle(nav).flexDirection : null }; }
                    out.scrollH = document.documentElement.scrollHeight; return out; })()`);
                assert.ok(r.coarse, `${tag}: emulated as a coarse pointer`);
                if (route === '/agents') {
                    const row = await ev(`(() => { const e = document.querySelector('#mobile-session-list .session-group-item'); if (!e) return document.getElementById('mobile-session-list').innerHTML.slice(0, 300); const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom) }; })()`);
                    assert.ok(row && row.b <= h, `${tag}: the first agent row is inside the screen (${JSON.stringify(row)})`);
                    continue;
                }
                assert.ok(r.vl, `${tag}: a view list is drawn`);
                assert.equal(r.vl.dir, 'row', `${tag}: the view list is a strip, not a column (${JSON.stringify(r)})`);
                assert.ok(r.vl.h <= 100, `${tag}: the strip is short, not a column (${JSON.stringify(r)})`);
            }
        }
        console.log('PASS landscape phone: the view list is a strip at 844x390 and 915x412');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
