// Home with an agent open (#10035, the desktop tester: "it looks like my chat vanished"): the welcome page replaces the chat, so the agent's row is no longer the selected one, and stays not selected when the list is drawn again
// (a poll); choosing the agent again selects it and opens its chat. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const rows = () => ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].map(li => ({ id: li.dataset.sessionId, active: li.classList.contains('active'), current: li.classList.contains('list-row-current'), aria: li.getAttribute('aria-current') }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__m.add('home-bot', 'A', 3, { sleeping: false }); true`); await settle(ev, 600); // sleep-ok: the first live list renders from several answers
        await ev(`window.selectLiveSession('home-bot', 'claude', 'home-bot-id', 'local'); true`);
        await waitFor(`getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, 'the agent page', 8000);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item.active')`, 'the open agent is the selected row', 6000);
        await ev(`window.__coral._goHome(); true`);
        await waitFor(`getComputedStyle(document.getElementById('welcome-screen')).display !== 'none'`, 'the welcome page', 6000);
        await settle(ev, 500); // sleep-ok: the row's fill fades out before it is looked at
        { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/home-no-selected-row.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
        let r = await rows();
        assert.ok(r.length >= 1 && r.every(x => !x.active && !x.current && x.aria === null), 'Home leaves no row selected: ' + JSON.stringify(r));
        await ev(`T.render.renderLiveSessions(T.state.liveSessions); true`); await settle(ev, 300); // sleep-ok: the list is drawn again, as a poll does
        r = await rows();
        assert.ok(r.every(x => !x.active && !x.current && x.aria === null), 'and drawn again it still has none: ' + JSON.stringify(r));
        await ev(`window.selectLiveSession('home-bot', 'claude', 'home-bot-id', 'local'); true`);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item.active') && getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, 'choosing the agent selects it again and opens its chat', 6000);
        console.log('PASS Home deselects the open agent, and choosing it again selects it');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
