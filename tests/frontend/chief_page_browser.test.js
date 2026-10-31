// The Chief page (/chief, #11450): the agent popout with nothing of Coral around it, for the Operator's phone: the chat, the composer and the cards an agent's asks make; no terminal switch, header actions, macro toolbar or
// tools pane. The server's gate (setting, recorded session) is Go's TestChiefPageServesOnlyTheRecordedAgentWhileTheSettingIsOn; this suite is the page's face at 390 px: the dashboard's pop-out mode with the page's marker
// (body data-chief), against the fixture rows of agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('chief-a', 'A', 3, { sleeping: false, display_name: 'Chief' }); true`);
        await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'chief-a-id')`, 'the agent row', 8000);
        await ev(`window.selectLiveSession('chief-a', 'claude', 'chief-a-id', 'local'); true`);
        await coralReady(ev, 'agentSelected', 'chief-a-id');
        const shown = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
        const before = {};
        for (const sel of ['.terminal-header', '#command-input', '.live-view-switch', '.command-pane-toolbar', '#agentic-state']) before[sel] = await ev(shown(sel));
        // the page's marker, as the server puts it on /chief
        await ev(`document.body.dataset.chief = '1'; true`);
        check(await ev(shown('.terminal-header')) && await ev(shown('#command-input')), 'the header (the agent\'s name) and the composer stay');
        for (const sel of ['.live-view-switch', '.command-pane-toolbar', '#agentic-state', '.terminal-header-actions', '.agent-bar-more', '.live-view-toggle']) check(!(await ev(shown(sel))), `${sel} is not on the Chief page`);
        check(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), 'no sideways scroll at 390 px');
        check(before['#command-input'] === true, 'the fixture shows the composer without the marker too (so hiding it would show)');
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the Chief page shows the chat and the composer and nothing else of Coral');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
