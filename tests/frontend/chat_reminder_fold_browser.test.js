// A reminder Coral typed into an agent is drawn as Coral's, small and labelled "Coral reminder", and a long one folds (#10012): the pill keeps to one
// line with a toggle that shows the whole text; a short one has no toggle. Never a bubble from "You". Drives the real dashboard over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const LONG = "[Task #4300 completed by QA Engineer] Outcome: success. Live smoke of the release: all four cases pass.\nScreenshots are in the artifact below.";

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`import((window.__coralStatic || '/static/') + 'live_chat.js').then(m => { window.__lc = m; return true; })`);
        await ev(`(() => { const b = document.createElement('div'); b.id = 'rf-box'; b.className = 'chat-messages chat-prose';
            b.style.cssText = 'position:absolute;left:0;top:0;width:860px;height:600px;overflow:auto;background:var(--bg-primary);z-index:99999;padding:12px'; document.body.appendChild(b); return true; })()`);
        await ev(`window.__lc.renderTranscript(${JSON.stringify([
            { type: 'user', content: 'Operator: hello' },
            { type: 'user', content: "[Wait resolved] done", coral_notice: true },
            { type: 'user', content: 'Operator: again' },
            { type: 'user', content: LONG, coral_notice: true },
        ])}, document.getElementById('rf-box'), 'claude')`);
        const st = await ev(`({
            labels: [...document.querySelectorAll('#rf-box .chat-system-label')].map(e => e.textContent),
            toggles: document.querySelectorAll('#rf-box .chat-system-toggle').length,
            bubbles: [...document.querySelectorAll('#rf-box .chat-bubble.human .message-text')].map(e => e.textContent.trim()),
        })`);
        assert.deepEqual(st.labels, ['Coral reminder', 'Coral reminder'], 'both are labelled as Coral\'s');
        assert.deepEqual(st.bubbles, ['Operator: hello', 'Operator: again'], 'only the operator\'s own turns are bubbles');
        assert.equal(st.toggles, 1, 'only the long reminder has a toggle');
        const h = () => ev(`document.querySelector('#rf-box .chat-system-toggle').closest('.chat-system').getBoundingClientRect().height`);
        const shut = await h();
        assert.equal(await ev(`document.querySelector('#rf-box .chat-system-toggle').getAttribute('aria-expanded')`), 'false');
        await ev(`document.querySelector('#rf-box .chat-system-toggle').click()`);
        assert.equal(await ev(`document.querySelector('#rf-box .chat-system-toggle').getAttribute('aria-expanded')`), 'true');
        const open = await h();
        assert.ok(open > shut + 10, `open shows the whole text on more lines (${shut} -> ${open})`);
        await ev(`document.querySelector('#rf-box .chat-system-toggle').click()`);
        assert.equal(Math.round(await h()), Math.round(shut), 'closed again is one line');
        // a steps row that holds only a reminder is named for it, not "1 step"
        const rows = await ev(`[...document.querySelectorAll('#rf-box .work-group-count')].map(e => e.textContent)`);
        assert.deepEqual(rows, ['Coral reminder', 'Coral reminder'], 'a group of only reminders says so: ' + JSON.stringify(rows));
        console.log('   ✓ labelled, long one folds');
        console.log('\nPASS Coral reminders are labelled and fold');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
