// The "New conversation" line after a restart survives a reload (#15517): the server marks a session that began by a Restart, and the chat draws the line from that mark when it loads, not only in the tab
// where the restart happened. A session with no mark (a wake, a resume, an agent never restarted) has none. 1280 and 390 px; each load is a new page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const lines = () => ev(`[...document.querySelectorAll('#live-history-messages > .chat-earlier-line')].map(e => e.textContent)`);
    const open = async (name, restarted) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.__m.add(${JSON.stringify(name)}, 'R', 4, { sleeping: false }); window.__m.agents[${JSON.stringify(name + '-id')}].restarted = ${restarted}; true`);
        await waitFor(`!!window.__m.agents[${JSON.stringify(name + '-id')}]`, 'the agent');
        await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(name + '-id')}, 'local'); true`);
        await waitFor(`window.__rendered().length > 0`, 'the chat drawn', 10000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await open('rl-agent', true);
            assert.deepEqual(await lines(), ['New conversation: context cleared, instructions sent again'], `${w}px: a session the server marks as restarted shows the line`);
            assert.equal(await ev(`(() => { const c = document.getElementById('live-history-messages'); return c.firstElementChild.classList.contains('chat-earlier-line'); })()`), true, `${w}px: at the top, above its first message`);
            await open('rl-agent', true); // a reload: a new page, nothing of the old DOM
            assert.equal((await lines()).length, 1, `${w}px: after a reload the line is still there, once`);
            await open('rl-woken', false);
            assert.deepEqual(await lines(), [], `${w}px: a session with no mark (a wake, a resume) has no line`);
            console.log(`PASS ${w}px restart line from the server's mark, kept over a reload, none for an unmarked session`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
