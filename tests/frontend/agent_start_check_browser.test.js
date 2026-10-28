// A start that takes too long says what to check (#10299, Desktop pass 26): an agent whose CLI has still not emitted its first event after 90 s says so in its chat, names the CLI, and says to check that it is installed and
// signed in and to open the terminal; before that the same title counts ("Starting Claude... 40 s") with the ordinary hint; a Codex agent says Codex. The seconds are not announced (aria-hidden). 1280 px, a stubbed list.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        const words = () => ev(`(() => { const e = document.querySelector('#live-history-messages > .chat-empty'); return e ? { title: (e.querySelector('.chat-empty-title') || {}).textContent || '', hint: (e.querySelector('.chat-empty-hint') || {}).textContent || '', secsHidden: (e.querySelector('.chat-empty-secs') || { getAttribute: () => null }).getAttribute('aria-hidden') } : null; })()`);
        const open = async (name, type, ageS) => {
            await ev(`window.__m.add('${name}', '${name}', 0, { sleeping: false, agent_type: '${type}' }); { const r = window.T.state.liveSessions.find(x => x.session_id === '${name}-id'); if (r) { r.starting = true; r.staleness_seconds = null; r.created_at = new Date(Date.now() - ${ageS} * 1000).toISOString(); } } true`);
            await ev(`window.selectLiveSession('${name}', '${type}', '${name}-id', 'local'); true`);
            await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, `the empty chat of ${name}`, 8000);
        };
        await open('sc-fresh', 'claude', 40);
        let w = await words();
        assert.match(w.title, /^Starting Claude\.\.\. (4\d) s$/, 'at 40 s it counts: ' + JSON.stringify(w));
        assert.match(w.hint, /first screen is not up yet/, 'with the ordinary hint: ' + w.hint);
        assert.equal(w.secsHidden, 'true', 'the seconds are not announced');
        await open('sc-late', 'claude', 100);
        w = await words();
        assert.match(w.title, /^Starting Claude\.\.\. (10\d) s$/, 'at 100 s it still counts: ' + JSON.stringify(w));
        assert.match(w.hint, /Still not ready after 90 s\. Check that Claude is installed and signed in, then open the terminal/, 'after 90 s it says what to check: ' + w.hint);
        await open('sc-codex', 'codex', 100);
        w = await words();
        assert.match(w.hint, /Check that Codex is installed and signed in/, 'it names the CLI: ' + w.hint);
        console.log('PASS a slow start counts and, after 90 s, says what to check');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
