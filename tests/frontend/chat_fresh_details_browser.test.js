// A fresh chat shows no Details bar above its first message (Mobile tester's pass, #10041): the collapsed Details disclosure sat above an empty chat and looked like an empty bar. While the chat's own "Say hello" line is up the bar
// is not drawn; it is back as soon as the chat has a message. At 390 and 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    const details = () => ev(`(() => { const d = document.getElementById('agent-phone-details'); return !!d && d.getClientRects().length > 0; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, `${w}: the fresh chat's Say hello line`, 10000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the header's facts arrive
            check(!(await details()), 'a fresh chat has no Details bar above its first message');
            // the first message arrives
            await ev(`(async () => { const c = document.getElementById('live-history-messages'); const m = document.createElement('div'); m.className = 'chat-msg chat-user'; m.textContent = 'hello'; c.insertBefore(m, c.firstChild); const mod = await import((window.__coralStatic || '/static/') + 'chat_prompt_empty.js'); mod.syncEmptyState(c); return true; })()`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the bar returns
            check(await details(), 'with a message in the chat the Details bar is back');
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Details on a fresh chat:\n  ' + problems.join('\n  '));
    console.log('PASS a fresh chat has no Details bar');
})().catch(e => { console.error(e); process.exit(1); });
