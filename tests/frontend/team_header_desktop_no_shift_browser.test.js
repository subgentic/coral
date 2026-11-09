// #14659 (v2.0.60 Windows gate, team_page_messages_browser at 1280: 'the h1 y moved on Messages (107 to 113.1)'): on a desktop the team page's title does not move while the team's availability read is on its way, when it lands, when it fails, and when the live list changes what the line says (the head row's height is the same in every state).
// The read (GET /api/board/<team>/status) is slow; each state is sampled: the title's top, the head's height, and the status and health pieces. Real isolated dev server (helpers/team_page.js). 1280 and 900 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-head-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 900], [900, 800]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const prev = window.fetch.bind(window); window.__statusMode = 'slow';
                window.fetch = (url, opts) => { const u = new URL(String(url), location.href); if (!/\\/api\\/board\\/[^/]+\\/status$/.test(u.pathname)) return prev(url, opts);
                    if (window.__statusMode === 'fail') return Promise.resolve(new Response('{}', { status: 500 }));
                    return new Promise(r => setTimeout(() => r(prev(url, opts)), 2500)); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            const sample = () => ev(`(() => { const q = id => document.getElementById(id), r = e => e ? Math.round(e.getBoundingClientRect().height * 10) / 10 : null, t = document.querySelector('.team-page-title'), s = q('team-page-status'), hb = q('team-page-health'), head = document.querySelector('.team-page-head');
                return { h1: t ? Math.round(t.getBoundingClientRect().top * 10) / 10 : null, head: r(head), status: s ? { text: s.textContent.slice(0, 30), cls: s.className, display: getComputedStyle(s).display, h: r(s) } : null, health: hb ? { hidden: hb.hidden, h: r(hb) } : null }; })()`);
            const seen = [];
            for (let i = 0; i < 4; i++) { seen.push(await sample()); await new Promise(r => setTimeout(r, 200)); } // sleep-ok: samples while the read is on its way
            await new Promise(r => setTimeout(r, 2400)); // sleep-ok: the delayed read lands
            seen.push(await sample());
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.liveSessions = []; window.__statusMode = 'fail'; document.dispatchEvent(new CustomEvent('coral:team-sleep-changed', { detail: { team: ${JSON.stringify(TEAM)} } })); return true; })`);
            await waitFor(`/unavailable/i.test((document.getElementById('team-page-status') || {}).textContent || '')`, `${w}: a failed read says Status unavailable`, 8000);
            seen.push(await sample());
            console.log(`${w}: ` + JSON.stringify(seen));
            const spread = k => Math.max(...seen.map(x => x[k])) - Math.min(...seen.map(x => x[k]));
            assert.ok(spread('h1') <= 0.5, `${w}: the title's top is one value in every state: ${JSON.stringify(seen)}`);
            assert.ok(spread('head') <= 0.5, `${w}: the head's height is one value in every state: ${JSON.stringify(seen)}`);
            await removeBoards(ev, [TEAM]).catch(() => {});
        }
        console.log('team_header_desktop_no_shift: ok');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
