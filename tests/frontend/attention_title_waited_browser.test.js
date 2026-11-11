// A question left unanswered for 5 minutes shows in the tab's title ("(1) ...") while the tab is on screen, with no sound and no strip (#15297, walk 17 H4): the badge stayed 1 and nothing else
// changed for 9 minutes. Younger than 5 minutes: the title is as it was; the number goes when nothing waits. The isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const title = () => ev(`document.title`);
        await ev(`(async () => { window.__att = await import((window.__coralStatic || '/static/') + 'attention.js'); return true; })()`);
        const base = (await title()).replace(/^\(\d+\+?\) /, '');
        await ev(`window.__att.setAttentionTotal(1, Date.now() - 60000); true`);
        assert.equal(await title(), base, 'waiting 1 minute: the title is as it was while the tab is on screen');
        await ev(`window.__att.setAttentionTotal(1, Date.now() - 6 * 60000); true`);
        assert.equal(await title(), '(1) ' + base, 'waiting 6 minutes: the title carries the count');
        await ev(`window.__att.setAttentionTotal(2, Date.now() - 6 * 60000); true`);
        assert.equal(await title(), '(2) ' + base, 'two waiting: the number follows');
        await ev(`window.__att.setAttentionTotal(0, NaN); true`);
        assert.equal(await title(), base, 'answered: the number goes');
        console.log('PASS attention_title_waited_browser');
    } finally { client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
