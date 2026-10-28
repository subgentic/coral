// The open agent's header says how old its goal is (#10123): "Goal, 25 min ago" from the row's summary_at, plain "Goal" without one, and a goal that is updated says the new age. Real page, isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const label = () => ev(`document.querySelector('#session-summary .goal-label').textContent.trim()`);
        const set = (summary, at) => ev(`import(${S} + 'render.js').then(m => { m.updateSessionSummary(${JSON.stringify(summary)}, ${JSON.stringify(at)}); return true; })`);
        await set('Build the thing', new Date(Date.now() - 25 * 60000).toISOString());
        assert.equal(await label(), 'Goal, 25 min ago', 'the header says the goal\'s age');
        assert.equal(await ev(`document.querySelector('#session-summary .summary-text').textContent`), 'Build the thing');
        await set('Build the thing', null);
        assert.equal(await label(), 'Goal', 'no time: plain Goal');
        await set('A new goal', new Date(Date.now() - 20000).toISOString());
        assert.equal(await label(), 'Goal, just now', 'a goal that was just written');
        console.log('PASS goal_age');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
