// The composer's model chip says where its model comes from (#10080, Mobile tester: after the first send the chip changed from "CLI default" to "Claude - Claude Opus 5.5" with no action, and nothing said why): by the code the row's model
// is the one the agent's own transcript recorded (what it actually runs), else a hook's report, else the one it was started with, and model_source says which. The chip's hover says it: "The model the agent reported", or "The model it
// was started with"; a row with no model keeps "CLI default" and no hover. 1280 px, isolated dev server, the harness's page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const chip = async row => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'model_chip.js'); m.updateModelChip(Object.assign({ agent_type: 'claude', name: 'x', session_id: 'x-id', sleeping: false, archived: false }, ${JSON.stringify(row)}), 'local');
            const c = document.getElementById('model-chip'); return { text: document.getElementById('model-chip-text').textContent, title: c.getAttribute('title') || '' }; })()`);
        const none = await chip({});
        assert.equal(none.text, 'CLI default'); assert.equal(none.title, '', 'no model, no hover: ' + JSON.stringify(none));
        const reported = await chip({ model: 'claude-opus-5-5', model_source: 'transcript' });
        assert.match(reported.text, /Opus/); assert.match(reported.title, /model the agent reported/i, 'a model its transcript recorded says so: ' + JSON.stringify(reported));
        const hook = await chip({ model: 'claude-opus-5-5', model_source: 'hook' });
        assert.match(hook.title, /model the agent reported/i, 'a hook report says so too: ' + JSON.stringify(hook));
        const launch = await chip({ model: 'claude-opus-5-5', model_source: 'launch' });
        assert.match(launch.title, /started with/i, 'the launch model says so: ' + JSON.stringify(launch));
        console.log('PASS the model chip says whether its model was reported by the agent or is the one it was started with');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
