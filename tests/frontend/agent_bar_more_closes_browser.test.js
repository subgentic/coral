// The Folder / Branch card (#11284 item 1, Mobile Beta Tester's v2.0.7 phone check): the agent page's ⋯ opens the Details card (folder, branch, model) under the row, and it stayed floating over the Files list
// after the person went on. It closes with a tap anywhere outside it, with Escape, and when another part of the agent page is opened (the Files tab); the ⋯ says it is closed each time. At 390 px and 1024 px
// (the widths that have the ⋯). Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[390, true], [1024, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('more-agent', 'A', 3, { sleeping: false, session_id: 'm-id', board_project: 'a-team' }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'more-agent')`, `${w}: the agent`, 10000);
            await ev(`window.selectLiveSession('more-agent', 'claude', 'm-id', 'local'); true`);
            await waitFor(`document.getElementById('terminal-header-label')?.textContent === 'more-agent' && document.querySelector('.terminal-header').getClientRects().length > 0`, `${w}: the header`, 10000);
            await waitFor(`!!document.getElementById('agent-bar-more') && document.getElementById('agent-bar-more').getClientRects().length > 0`, `${w}: the ⋯`, 8000);
            const state = () => ev(`(() => { const d = document.getElementById('agent-phone-details'), b = document.getElementById('agent-bar-more'); return { open: d.open, expanded: b.getAttribute('aria-expanded'), more: document.querySelector('.terminal-header').hasAttribute('data-more') }; })()`);
            const openMore = async () => { await ev(`document.getElementById('agent-bar-more').click(); true`); await waitFor(`document.getElementById('agent-phone-details').open`, `${w}: ⋯ opens the card`, 4000); assert.deepEqual(await state(), { open: true, expanded: 'true', more: true }); };
            const closed = { open: false, expanded: 'false', more: false };

            await openMore();
            await ev(`document.getElementById('live-history-messages').click(); true`); // a tap outside the card and the row
            await waitFor(`!document.getElementById('agent-phone-details').open`, `${w}: an outside tap closes it`, 4000);
            assert.deepEqual(await state(), closed, `${w}: the ⋯ says closed after an outside tap`);

            await openMore();
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            await waitFor(`!document.getElementById('agent-phone-details').open`, `${w}: Escape closes it`, 4000);
            assert.deepEqual(await state(), closed, `${w}: the ⋯ says closed after Escape`);

            await openMore();
            await ev(`window.switchAgenticTab('files', 'top'); true`);
            await waitFor(`!document.getElementById('agent-phone-details').open`, `${w}: opening the Files tab closes it (it floated over the list)`, 4000);
            assert.deepEqual(await state(), closed, `${w}: the ⋯ says closed after the Files tab opens`);

            await openMore();
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            await waitFor(`!document.getElementById('agent-phone-details').open`, `${w}: the ⋯ still toggles it shut`, 4000);
            assert.deepEqual(await state(), closed);
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS the agent page\'s Details card closes with an outside tap, Escape and the Files tab');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
