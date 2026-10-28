// Settings > Network and Hub (#10481 point 4, Beta): the pane starts with how to use Coral from a phone or another computer (Remote access and the setup code), the health card (Status) comes below, and
// Coral Hub has one way in: one "Connect to Coral Hub" button, not two with the same name. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.getElementById('settings-tab-network')`, 'the Network tab', 15000);
        await ev(`document.getElementById('settings-tab-network').click(); true`);
        await waitFor(`!!document.getElementById('settings-pane-network') && !document.getElementById('settings-pane-network').hidden`, 'the Network pane', 8000);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the status groups fill from their requests
        const pane = await ev(`(() => { const p = document.getElementById('settings-pane-network'); const shown = e => e.getClientRects().length > 0; const heads = [...p.querySelectorAll('h4, h5, .sv-heading, [id^="net-"][id$="-title"], .settings-group-title')].filter(shown).map(e => ({ text: e.textContent.trim(), y: Math.round(e.getBoundingClientRect().top) })).sort((a, b) => a.y - b.y);
            const connect = [...p.querySelectorAll('button')].filter(b => shown(b) && /^Connect to Coral Hub/i.test((b.textContent || b.getAttribute('aria-label') || '').trim())).map(b => b.textContent.trim()); return { heads, connect }; })()`);
        const texts = pane.heads.map(h => h.text);
        const phone = texts.findIndex(t => /Use from my phone or another computer/i.test(t)), status = texts.findIndex(t => /^Status$/i.test(t));
        assert.ok(phone >= 0, 'the pane has a group "Use from my phone or another computer": ' + JSON.stringify(texts));
        assert.ok(phone < (status < 0 ? 99 : status), 'it comes before the health card (Status): ' + JSON.stringify(texts));
        assert.ok(phone <= 1, 'it is the first group of the pane (after the pane title): ' + JSON.stringify(texts));
        assert.ok(pane.connect.length <= 1, 'Coral Hub has one Connect button, not several: ' + JSON.stringify(pane.connect));
        console.log('PASS Network and Hub: phone and other computers first, Status below, one Connect button');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
