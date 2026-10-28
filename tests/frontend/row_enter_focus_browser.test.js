// Opening a chat from its row by keyboard puts the keyboard in the message box (Beta #10401 moment 4, #10410): Enter on an agent's row opened its chat and left the keyboard on the row, so the next words went into "Search agents".
// With a mouse the click already put the cursor in the box (unchanged); at a touch screen the keyboard goes to the page's heading, not the box (no on-screen keyboard over the chat). 1280 px with a mouse, 390 px with touch; a
// stubbed agent. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, touch, want] of [[1280, 800, false, 'command-input'], [390, 844, true, 'session-name']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: touch }); await Emulation.setTouchEmulationEnabled({ enabled: touch });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.__m.add('coral-go', 'm', 3, { sleeping: false, session_id: 'o1' }); T.state.liveSessions = Object.values(window.__m.agents).map(a => window.__m.entry(a)); T.render.renderLiveSessions(T.state.liveSessions); true`);
            await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item, #mobile-session-list .session-group-item')`, `${w}: the agent's row`, 10000);
            await ev(`(() => { const r = document.querySelector('#live-sessions-list .session-group-item, #mobile-session-list .session-group-item'); r.focus(); return document.activeElement === r; })()`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0 || !!document.getElementById('session-name')`, `${w}: the chat`, 10000);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the page takes the keyboard after the view shows
            const got = await ev(`document.activeElement ? document.activeElement.id : ''`);
            if (got !== want) problems.push(`${w}: Enter on the row puts the keyboard on #${want} (it is on #${got})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'opening a chat by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Enter on an agent row puts the keyboard in the chat');
})().catch(e => { console.error(e); process.exit(1); });
