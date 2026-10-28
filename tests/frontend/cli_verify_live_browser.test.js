// Settings > Agents > CLI paths, Verify All, by keyboard (#10693, the first-run keyboard and screen-reader pass): (1) the keyboard stays on the Verify All button while it checks (it was disabled, and a disabled focused button
// drops the focus to the page); (2) each CLI's verdict (Found, Not found, Error) is in a live region, so a screen reader says it when it arrives (the result lines were plain text: Verify All said nothing); (3) the checking
// state is a word, not "...". At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js; the CLI check is answered by the test, held until released.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { window.__release = null; const real = window.fetch; const json = b => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/system/cli-check' && p.searchParams.has('binary')) { const type = p.searchParams.get('type'); return new Promise(res => { const prev = window.__release; window.__release = () => { if (prev) prev(); res(json(type === 'agy' ? { found: false } : { found: true, version: 'v1.' + type })); }; }); } return real(u, o); }; return true; })()`);
            await ev(`(async () => { await window.showSettingsModal('agents'); return true; })()`); await waitFor(`!!document.getElementById('settings-cli-path-agy')`, `${w}: Settings, Agents`, 8000);
            await ev(`document.getElementById('settings-cli-path-agy').closest('details').open = true; true`);
            await waitFor(`document.getElementById('verify-all-btn') && document.getElementById('verify-all-btn').getClientRects().length > 0`, `${w}: the Verify All button`, 8000);
            // (2) before anything is checked each verdict's place is already a live region (a region that appears already filled is not reliably said)
            const live = await ev(`['claude', 'codex', 'agy', 'pi'].filter(t => { const e = document.getElementById('cli-result-' + t); return !e.closest('[role=status], [role=alert], [aria-live]:not([aria-live=off])'); })`);
            if (live.length) problems.push(`${w}: the verdict of ${live.join(', ')} is not in a live region: Verify All says nothing`);
            // (1) Enter on Verify All: the keyboard stays on the button while it checks
            await ev(`document.getElementById('verify-all-btn').focus(); true`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`document.getElementById('verify-all-btn').textContent !== 'Verify All'`, `${w}: it is checking`, 4000);
            const during = await ev(`(() => { const a = document.activeElement; return { onButton: a === document.getElementById('verify-all-btn'), now: a ? (a.id || a.tagName) : 'nothing', claude: document.getElementById('cli-result-claude').textContent }; })()`);
            if (!during.onButton) problems.push(`${w}: the keyboard left Verify All while it checked (it is on ${during.now})`);
            if (/^\.+$/.test(during.claude.trim())) problems.push(`${w}: the checking state is "${during.claude}", not a word`);
            await ev(`window.__release(); true`);
            await waitFor(`document.getElementById('verify-all-btn').textContent === 'Verify All'`, `${w}: Verify All finished`, 8000);
            const after = await ev(`({ claude: document.getElementById('cli-result-claude').textContent, agy: document.getElementById('cli-result-agy').textContent, on: document.activeElement === document.getElementById('verify-all-btn') })`);
            if (!/v1\.claude|Found/.test(after.claude) || !/Not found/.test(after.agy)) problems.push(`${w}: the verdicts are written: ${JSON.stringify(after)}`);
            if (!after.on) problems.push(`${w}: the keyboard is still on Verify All when it finishes`);
            await ev(`window.hideSettingsModal(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Verify All by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Verify All keeps the keyboard and says its verdicts');
})().catch(e => { console.error(e); process.exit(1); });
