// The Docs search reads the topics' text, not only their titles (#9965, Beta Tester pass 3 point 8): a word that is in a topic's body but in no title finds that topic ("sandbox" is in Hooks and Troubleshooting).
// A title match still shows at once; a word that is nowhere says so. The real docs of the isolated dev server, 1280 px.
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
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); };
        const shown = () => ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);
        await search('sandbox');
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 0`, 'a word in the topics\' text finds them', 15000);
        const found = await shown();
        assert.ok(found.includes('hooks') && found.includes('troubleshooting'), 'sandbox is in the text of Hooks and Troubleshooting: ' + JSON.stringify(found));
        await search('quickstart'); // a title word still matches at once
        await waitFor(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].some(b => b.dataset.doc === 'quickstart')`, 'a title match', 5000);
        await search('zzqxnotaword');
        await waitFor(`/No topic matches\. Try other words, or clear the search\./.test(document.getElementById('docs-nav-list').textContent)`, 'a word that is nowhere says so', 15000);
        console.log('PASS the Docs search finds a word in a topic\'s text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
