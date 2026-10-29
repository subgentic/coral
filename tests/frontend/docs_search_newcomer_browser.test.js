// The Docs search for a newcomer's single word (#10907, Mobile Beta Tester's phone pass 2): "permission", "permissions", "continue", "resume" and "sleep" put the How do I...? answer first, with the line that answers it as the snippet,
// not an API page and not a caveat line. It holds on the new "How do I...?" answers (#10765: Continue an old chat, What the permission modes allow) and on the rank by where the word sits (#10303). Against the real docs of the isolated dev server, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const WANT = {
    permission: /What the permission modes allow/,
    permissions: /permissions/i,
    continue: /Continue an old chat/,
    resume: /Resume/,
    sleep: /Put a team's agents to sleep/,
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 15000);
        for (const [q, snipRe] of Object.entries(WANT)) {
            await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent) && document.querySelector('#docs-nav-list [data-doc]')`, `the search for ${q}`, 20000);
            await sleep(400); // sleep-ok: the list is drawn again once the topics' text has arrived
            const top = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].slice(0, 5).map(b => b.dataset.doc)`);
            assert.equal(top[0], 'how-do-i', `"${q}": the How do I...? answer is first, not an API page: ${top.join(', ')}`);
            const snip = await ev(`((document.querySelector('#docs-nav-list [data-doc="how-do-i"]').closest('li') || document.body).querySelector('.doc-snippet') || {}).textContent || ''`);
            assert.match(snip, snipRe, `"${q}": the snippet is the line that answers it: ${snip}`);
        }
        console.log('PASS Docs search: a newcomer\'s single word puts the How do I...? answer first');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
