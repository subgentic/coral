// #13079: the page asks for the open agent's /poll one at a time. The timer beats every 500 ms (the terminal view with no socket); a server that takes seconds to answer used to have 10 to 20 polls on the way at once,
// each adding the work that made it slow. Here the answer is held for 2.5 s: never more than one poll is out, and while it is slow the page asks less often, not more.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + `;localStorage.setItem('coral-live-view-mode', 'terminal');(() => { window.__out = 0; window.__maxOut = 0; window.__polls = 0; window.__hold = 0;
            const f = window.fetch; window.fetch = function (u) { if (/\\/api\\/sessions\\/live\\/[^/?]+\\/poll/.test(String(u)) && window.__hold) { window.__polls++; window.__out++; window.__maxOut = Math.max(window.__maxOut, window.__out);
                return new Promise(r => setTimeout(r, window.__hold)).then(() => f.apply(this, arguments)).finally(() => { window.__out--; }); } return f.apply(this, arguments); }; })();` });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { window.__m.add('slow-a', 'S', 4, { sleeping: false, session_id: 'slow-a-id' }); window.selectLiveSession('slow-a', 'claude', 'slow-a-id', 'local'); return true; })()`);
        await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled`, 'the agent', 10000);
        await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the first polls of the open agent settle before the slow window is counted
        await ev(`window.__polls = 0; window.__maxOut = 0; window.__hold = 2500; true`);
        await ev(`new Promise(r => setTimeout(r, 7000))`); // sleep-ok: seven seconds of the timer's beats against an answer that takes 2.5 s
        const r = await ev(`({ maxOut: window.__maxOut, polls: window.__polls })`);
        console.log(`slow answers: at most ${r.maxOut} polls out at once, ${r.polls} polls started in 7 s`);
        assert.equal(r.maxOut, 1, `one poll of the agent is out at a time (a 500 ms beat against a 2.5 s answer had up to 5): ${r.maxOut}`);
        assert.ok(r.polls <= 3, `a slow server is asked less often: ${r.polls} polls in 7 s against 2.5 s answers`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
