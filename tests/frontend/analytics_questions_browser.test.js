// Each Analytics page is subtitled by the question it answers (#10482, Beta Analytics pass): Overview "What am I spending?", Tokens per commit "What did each commit cost?", Task time "How long do tasks take?",
// Tool and API calls "Which calls does the work make?"; a grouping of Overview keeps Overview's question. 1280 and 390 px; the usage reads are stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const QUESTIONS = { overview: 'What am I spending?', 'per-commit': 'What did each commit cost?', 'task-time': 'How long do tasks take?', calls: 'Which calls does the work make?', model: 'What am I spending?' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.getElementById('cost-view-title')`, `${w}: the page`, 10000);
            for (const [key, question] of Object.entries(QUESTIONS)) {
                await ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView(${JSON.stringify(key)}); return true; })`);
                await sleep(150); // sleep-ok: the page redraws after the choice
                const got = await ev(`(() => { const q = document.getElementById('cost-view-question'); return q ? { text: q.textContent.trim(), shown: q.getClientRects().length > 0 } : null; })()`);
                assert.ok(got, `${w}: ${key}: the page has a line for its question`);
                assert.equal(got.text, question, `${w}: ${key}: the question`);
                assert.equal(got.shown, true, `${w}: ${key}: it is on the screen`);
            }
        }
        console.log('PASS Analytics pages say their question');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
