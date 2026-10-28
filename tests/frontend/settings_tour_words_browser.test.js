// Settings tour words (#10324, Desktop #10321): each setting says in plain words what it does or what it risks, before the switch. One section per pane. 1280 px, real isolated server; the settings guard puts
// the shard's settings back. The text read is the row's (hidden More text too), so a sentence behind More counts.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const row = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e && (e.closest('.settings-row, .sv-row') || e.parentElement); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    const options = id => ev(`[...document.getElementById(${JSON.stringify(id)}).options].map(o => o.textContent.trim())`);
    const text = id => ev(`(document.getElementById(${JSON.stringify(id)}) || {}).textContent && document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g, ' ').trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('general')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-group-by-team') && !!document.getElementById('settings-remote-access-enabled') && !!document.getElementById('tb-choice')`, 'the Settings rows', 10000);

        // PANE General
        assert.match(await row('settings-group-by-team'), /Group agents by team/, 'General: the grouping says team, not "board or team"');
        assert.doesNotMatch(await row('settings-group-by-team'), /board or team/, 'General: one word for it');
        assert.match(await row('settings-group-by-team'), /Agents on the same team sit together in the list/, 'General: and what it does');
        // END General






        console.log('PASS Settings tour words');
    } finally { await client.close(); await guard.restore(); }
})().catch(e => { console.error(e); process.exit(1); });
