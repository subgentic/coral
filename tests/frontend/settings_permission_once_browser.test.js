// Settings > Agents says what the default permission mode means once (#10266 point 2, Mobile pass 18): under the select is the line for the chosen mode; the contrast of Default, Auto and Not set is behind
// the row's "More" and is not a second visible line saying the same thing. 390 and 1280 px. Real isolated server; the settings guard puts the shard's settings back.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
            await waitFor(`!!document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').getClientRects().length > 0`, `${w}: the permission row`, 10000);
            const r = await ev(`(() => { const row = document.getElementById('settings-permission-mode').closest('.settings-row, .sv-row');
                const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const lines = [...row.querySelectorAll('.sv-help, .perm-mode-desc, .perm-mode-compare, .settings-hint')].filter(vis).map(e => e.textContent.trim()).filter(Boolean);
                return { lines, compare: !!row.querySelector('.perm-mode-compare'), all: row.textContent.replace(/\\s+/g, ' ') }; })()`);
            assert.equal(r.compare, false, `${w}: no second line comparing the three modes under the select: ${JSON.stringify(r.lines)}`);
            assert.ok(r.lines.some(l => /Auto/.test(l)), `${w}: the chosen mode's line is there: ${JSON.stringify(r.lines)}`);
            assert.match(r.all, /Default asks before acting; Auto acts on its own; Not set uses Auto\./, `${w}: the contrast is one click away, in the row's More`);
        }
        console.log('PASS Settings > Agents: the permission meaning is said once, the contrast is behind More, at 1280 and 390');
    } finally { await client.close(); await guard.restore?.(); }
})().catch(e => { console.error(e); process.exit(1); });
