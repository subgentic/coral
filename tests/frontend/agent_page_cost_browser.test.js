// The agent page's cost while it says nothing (#9101, Goal #85, the audit's measure): the chat is read every second at first and then less and less often (1 s, then up to 10 s), a key press brings it back to every second,
// and a sleeping agent, which has no terminal, does not fetch the 439 KB of terminal code ahead of a view it cannot show; an awake agent still does (#4518). The agent is the harness's mocked one: its chat requests are counted
// in window.__m.requests, the terminal files in the page's resource timing. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the measure is requests over wall-clock seconds
    const chats = name => ev(`window.__m.requests.filter(r => r.kind === 'chat' && r.agent === ${JSON.stringify(name)}).length`);
    const xterm = () => ev(`performance.getEntriesByType('resource').filter(e => /xterm/.test(e.name)).length`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('quiet-agent', 'Q', 4, { sleeping: false }); window.__m.add('asleep-agent', 'S', 4, { sleeping: true }); true`);

        console.log('1. A sleeping agent: no terminal code is fetched ahead');
        await ev(`window.selectLiveSession('asleep-agent', 'claude', 'asleep-agent-id', 'local'); true`);
        await sleep(4500); // sleep-ok: past the 2 s prefetch idle; the absence of a request has no event
        assert.equal(await xterm(), 0, 'no xterm file was requested for a sleeping agent: ' + await xterm());

        console.log('2. An awake agent in the chat view: the chat poll slows down while nothing arrives');
        await ev(`window.selectLiveSession('quiet-agent', 'claude', 'quiet-agent-id', 'local'); true`);
        await waitFor(`window.__m.requests.some(r => r.kind === 'chat' && r.agent === 'quiet-agent')`, 'the first chat read', 10000);
        const t0 = Date.now(), c0 = await chats('quiet-agent');
        await sleep(14000); // sleep-ok: the measure is the requests made over 14 seconds of silence
        const c1 = await chats('quiet-agent');
        assert.ok(c1 - c0 <= 8, `at most 8 chat reads in 14 s of silence (it was 14): ${c1 - c0}`);
        assert.ok(await xterm() > 0, 'an awake agent still gets the terminal code ahead of time (#4518)');

        console.log('3. A key press brings the every-second poll back');
        const before = await chats('quiet-agent');
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); true`);
        await waitFor(`window.__m.requests.filter(r => r.kind === 'chat' && r.agent === 'quiet-agent').length > ${before}`, 'a chat read right after the key press', 3500);
        console.log('PASS agent page cost: ' + (c1 - c0) + ' chat reads in 14 s of silence, woken by a key press, no terminal code for a sleeping agent');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
