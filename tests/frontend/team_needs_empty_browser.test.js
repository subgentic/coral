// #15239 (walk 10 M15): a team's Needs you with nothing waiting says so in a sentence (as the Inbox does), not a bare column header over an empty box. Real board, 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [], S = `(window.__coralStatic || '/static/')`;
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const board = 'team-needs-empty-' + Date.now().toString(36); boards.push(board);
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
            await ev(`import(${S} + 'nav.js').then(async n => { const r = await import(${S} + 'routes.js'); await n.go(r.parse('/team/${board}/needs')); return true; })`);
            await waitFor(`!!document.getElementById('team-tab-needs') && document.getElementById('team-tab-needs').getAttribute('aria-selected') === 'true'`, at + 'the Needs you tab opens', 12000);
            await ev(`new Promise(r => setTimeout(r, 2500))`); // sleep-ok: the tab reads its sources
            const t = await ev(`(() => { const p = document.querySelector('.team-needs-body') || document.getElementById('team-page-body'); return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
            console.log(at + JSON.stringify(t));
            assert.ok(t && /You are all caught up/.test(t), at + 'an empty Needs you says "You are all caught up" (#15259): ' + JSON.stringify(t));
        }
    } finally {
        for (const b of boards) await api('DELETE', `/api/board/${b}`, {}).catch(() => {});
        await client.close();
    }
    console.log('team_needs_empty_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
