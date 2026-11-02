// A Needs you row for an agent at a prompt Coral cannot offer answers for (Claude's "Is this a project you trust?", #12346, Beta Tester's v2.0.35 run) had only Dismiss, so the person had to find the agent's chat.
// It now has Open agent, which goes straight to that agent's chat; nothing is typed for the person. A row that does have choices keeps them and does not get the button. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const ago = min => new Date(Date.now() - min * 60000).toISOString();
    const trust = { why: 'a prompt is open: Quick safety check: Is this a project you trust?', what: 'board message', at: ago(0), since: ago(12) };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'd1', name: 'coral-d1', display_name: 'Security Reviewer', agent_type: 'claude', model: 'claude-opus-5-5', server: 'local', board_unread: 5, working: false, context_pct: null, skipped_send: ${JSON.stringify(trust)} }];
            window.__opened = null; window.selectLiveSession = (...a) => { window.__opened = a; }; const real = window.fetch; window.fetch = (u, o) => String(u).includes('/ask') && String(u).includes('d1') ? Promise.resolve(new Response(JSON.stringify({ choices: [], ask: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view tbody tr .inbox-answers')`, 'the dialog row with its answers cell', 15000);
        await waitFor(`!!document.querySelector('#group-table-view .inbox-open-agent')`, 'Open agent on a row with nothing to answer', 8000);
        const names = await ev(`[...document.querySelectorAll('#group-table-view tbody tr .inbox-answers button')].map(b => b.textContent.trim())`);
        assert.deepEqual(names, ['Open agent', 'Dismiss'], 'the row offers Open agent, then Dismiss: ' + JSON.stringify(names));
        assert.equal(await ev(`document.querySelector('#group-table-view .inbox-open-agent').getAttribute('aria-label')`), 'Open Security Reviewer to answer');
        await ev(`document.querySelector('#group-table-view .inbox-open-agent').click(); true`);
        assert.deepEqual((await ev('window.__opened || null'))?.slice(0, 3), ['coral-d1', 'claude', 'd1'], "the click opens that agent's chat, and not the row's own page");
        console.log('PASS the Needs you row of an agent at a prompt it cannot answer has Open agent, which goes to its chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
