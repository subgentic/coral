// The folder browser's up button reads ".." and its title said "Go up", but a title is only a description when the button has words: a screen reader said "dot dot" (#10693, the first-run pass; the Mobile Beta Tester's
// pass 37). Every up button of the folder browsers (New agent, New project, Resume, Open folder, Terminal, the job form) now names itself. Drives Chrome over CDP through agent_view_harness.js: the accessibility tree's
// own name for each, at 1280 and 390 px, with New agent's browser opened.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.showLaunchModal(); true`); await waitFor(`document.querySelector('#launch-modal .modal-content') && document.querySelector('#launch-modal .modal-content').getClientRects().length > 0`, `${w}: the launch dialog`, 8000);
            await ev(`window._selectLaunchType('agent'); true`); await waitFor(`!!document.getElementById('btn-browse') && document.getElementById('btn-browse').getClientRects().length > 0`, `${w}: New agent, step 1`, 8000);
            await ev(`document.getElementById('btn-browse').click(); true`);
            await waitFor(`!!document.querySelector('#dir-browser .dir-browser-up') && document.querySelector('#dir-browser .dir-browser-up').getClientRects().length > 0`, `${w}: the folder browser`, 8000);
            const names = await ev(`[...document.querySelectorAll('.dir-browser-up')].map(b => (b.getAttribute('aria-label') || '').trim())`);
            const bad = names.filter(n => !/^Go up/.test(n));
            if (!names.length || bad.length) problems.push(`${w}: ${bad.length} of ${names.length} up buttons have no name of their own (they read "..")`);
            const ax = await client.Accessibility.getFullAXTree();
            const unnamed = ax.nodes.filter(n => !n.ignored && n.role && n.role.value === 'button' && /^\.+$/.test(((n.name && n.name.value) || '').trim()));
            if (unnamed.length) problems.push(`${w}: the accessibility tree names ${unnamed.length} button(s) "${unnamed[0].name.value}"`);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the folder browser up button:\n  ' + problems.join('\n  '));
    console.log('PASS the folder browser up button has a name');
})().catch(e => { console.error(e); process.exit(1); });
