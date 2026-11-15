// #17151 follow-up (#17585): searching the docs without selecting a topic shows "Pick a result"
// in the content pane (not a group table), and the troubleshooting doc's git section quotes the
// button as "Make it a git repo" and says the no-worktree toggle is under "More options".
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);

        // search for a word that returns results but do NOT click a topic
        await ev(`(() => { const i = document.getElementById('docs-search'); i.value = 'sandbox'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 0`, 'search results', 15000);

        // the right-side content pane says "Pick a result" (not a group table or blank)
        const pane = await ev(`(() => { const p = document.getElementById('docs-content'); return p ? p.textContent.trim() : ''; })()`);
        assert.match(pane, /Pick a result/, '"Pick a result" pane shown when search active but no topic selected: ' + JSON.stringify(pane.slice(0, 80)));

        // open the troubleshooting doc and check the corrected text
        await ev(`(() => { const b = document.querySelector('#docs-nav-list [data-doc="troubleshooting"]'); if (b) b.click(); return !!b; })()`);
        await waitFor(`document.getElementById('docs-content')?.textContent.length > 100`, 'troubleshooting doc loaded', 8000);
        const text = await ev(`document.getElementById('docs-content').textContent`);
        assert.match(text, /Make it a git repo/, 'the doc quotes the button as "Make it a git repo"');
        assert.match(text, /under\s+More options/, 'the doc says the toggle is under "More options"');

        console.log('PASS Docs: Pick a result pane and troubleshooting text (#17585)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
