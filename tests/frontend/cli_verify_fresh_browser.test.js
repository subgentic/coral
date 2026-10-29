// Settings > Agents > CLI paths > Verify All on a page that has only opened Settings (#10693, the first-run keyboard and screen-reader pass): the button did nothing until the New agent dialog had been opened, because the
// check lives in cli_dialogs.js, which only the launch dialogs loaded (the button's action called a function that was not there yet). Now it loads the check itself. At 1280 and 390 px. Drives Chrome over CDP through
// agent_view_harness.js; the CLI check is answered by the test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/system/cli-check' && p.searchParams.has('binary')) { const type = p.searchParams.get('type'); return json(type === 'agy' ? { found: false } : { found: true, version: 'v1.' + type }); } return real(u, o); }; return true; })()`);
            await ev(`(async () => { await window.showSettingsModal('agents'); return true; })()`); await waitFor(`!!document.getElementById('settings-cli-path-agy')`, `${w}: Settings, Agents`, 8000);
            await ev(`document.getElementById('settings-cli-path-agy').closest('details').open = true; document.getElementById('settings-cli-path-agy').value = ''; true`);
            await waitFor(`document.getElementById('verify-all-btn') && document.getElementById('verify-all-btn').getClientRects().length > 0`, `${w}: the Verify All button`, 8000);
            await ev(`document.getElementById('verify-all-btn').focus(); true`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            try { await waitFor(`/Not installed/.test(document.getElementById('cli-result-agy').textContent)`, `${w}: Verify All answers`, 5000); }
            catch { problems.push(`${w}: Enter on Verify All on a page that only opened Settings checks nothing (the results are ${JSON.stringify(await ev(`['claude', 'agy'].map(t => document.getElementById('cli-result-' + t).textContent)`))})`); }
            await ev(`window.hideSettingsModal(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Verify All on a fresh page:\n  ' + problems.join('\n  '));
    console.log('PASS Verify All works before the launch dialog has been opened');
})().catch(e => { console.error(e); process.exit(1); });
