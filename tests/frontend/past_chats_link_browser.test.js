// The agent list has a "Past chats" link under it (#10055, Beta #10105: where did my old chats go?): one click opens Inbox > All chats. Real isolated server, one agent. 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('past-bot', 'A', 2, { sleeping: false }); true`);
        await ev(`(() => { T.state.liveSessions = [window.__m.entry(window.__m.agents['past-bot-id'])]; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`!!document.getElementById('agent-past-chats') && document.querySelectorAll('#live-sessions-list .session-group-item').length >= 1`, 'the list and its Past chats link', 8000);
        console.log('1. Past chats sits under the agent list');
        const at = await ev(`(() => { const l = document.getElementById('agent-past-chats').getBoundingClientRect(), r = [...document.querySelectorAll('#live-sessions-list .session-group-item')].pop().getBoundingClientRect(); return { word: document.getElementById('agent-past-chats').textContent.trim(), under: l.top >= r.bottom - 1, visible: l.height > 0 }; })()`);
        assert.deepEqual(at, { word: 'Past chats', under: true, visible: true }, JSON.stringify(at));
        await shot('past-chats-link');
        console.log('2. one click opens Inbox > All chats');
        await ev(`document.getElementById('agent-past-chats').click(); true`);
        await waitFor(`document.body.getAttribute('data-nav-tab') === 'hub-inbox'`, 'the Inbox tab', 8000);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the folder's table draws after the tab switch
        await shot('past-chats-opened');
        assert.ok(await ev(`[...document.querySelectorAll('h1, h2')].some(e => e.offsetParent && /^All chats/.test(e.textContent.trim()))`), 'the page is titled All chats');
        console.log('PASS Past chats opens All chats');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
