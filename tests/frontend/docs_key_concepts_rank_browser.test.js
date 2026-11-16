// #17508: the key-concepts page must rank first when a search matches one of its headings
// ("what is a goal", "what is a task", "done when"). Against the real docs of the isolated dev server.
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
        await ev(`localStorage.setItem('coral-sidebar-groups-docs', '[]'); true`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); };
        const first = () => ev(`(document.querySelector('#docs-nav-list [data-doc]') || {}).dataset?.doc || ''`);
        for (const q of ['what is a goal', 'what is a task', 'done when']) {
            await search(q);
            await waitFor(`document.querySelector('#docs-nav-list [data-doc="key-concepts"]')`, `key-concepts in results for "${q}" (waits for doc text)`, 15000);
            const top = await first();
            assert.equal(top, 'key-concepts', `"${q}" → first result must be key-concepts, got ${top}`);
        }
        // "goal" alone must NOT put key-concepts first (docs_second_goal_browser pins how-do-i)
        await search('goal');
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 0`, 'results for "goal"', 15000);
        const goalTop = await first();
        assert.notEqual(goalTop, 'key-concepts', `"goal" alone must not boost key-concepts first, got ${goalTop}`);
        console.log('PASS key-concepts ranks first for definition queries');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
