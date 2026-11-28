// The Health check item (the team menu's, #22105; it was the team line's pulse) on a team of another computer (a self-hosted hub's remote team) opens that team's Health check settings, read from that computer through the hub's proxy (/api/remote/<id>/...), the way a local
// team's does (#19509: the pulse was a span, so a click did nothing). The remote computer's answers are stubbed (fetch); the click is a real one on the button the team row draws.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;
const TEAM = 'remote-health-19509';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = width + ' px: ';
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { window.__asked = []; const R = window.fetch.bind(window);
                window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u); if (/\\/api\\/remote\\/ws1\\//.test(url)) { window.__asked.push(url); return Promise.resolve(new Response(JSON.stringify({ mode: 'none', presets: [], health: {}, exists: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return R(u, o); }; return true; })()`);
            await ev(`import(${S} + 'list_card_parts.js').then(m => { const host = document.createElement('div'); host.id = 'probe-host'; host.innerHTML = m.teamHealthItem('@ws1/${TEAM}', [{ team_health_on: true }]); document.body.append(host); return true; })`);
            assert.equal(await ev(`document.querySelector('#probe-host .team-health-item').tagName`), 'BUTTON', at + 'a remote team has the Health check item (#22105: it was the pulse icon)');
            await ev(`document.querySelector('#probe-host .team-health-item').click(); true`);
            await waitFor(`window.__asked.some(u => /\\/api\\/remote\\/ws1\\/api\\/board\\/${TEAM}\\/settings/.test(u))`, at + 'its settings are asked of that computer through the proxy', 10000)
                .catch(async e => { throw new Error(e.message + ' asked: ' + JSON.stringify(await ev('window.__asked'))); });
        }
        console.log('PASS the Health check pulse of a remote team opens its settings, read through the hub proxy');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
