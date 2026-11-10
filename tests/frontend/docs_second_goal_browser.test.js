// "How do I give the team a second goal?" (#15273, walk 14 H6): the How do I topic has the recipe (the Goals tab, New goal, Create goal), and a search for "goal" or "second goal" puts How do I first and every plain
// topic above the For developers pages (the Board, Teams and Sessions APIs). The real docs of the isolated dev server, 1093 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1093, height: 614, deviceScaleFactor: 1366 / 1093, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.setItem('coral-sidebar-groups-docs', '[]'); true`); // both groups open
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = q => ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const list = () => ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => ({ doc: b.dataset.doc, text: (b.closest('tr, li, [role=row]') || b).textContent.replace(/\\s+/g, ' ').trim(), api: !!b.closest('[data-group="api"], [data-group-key="api"]') }))`);
        for (const q of ['goal', 'second goal']) {
            await search(q);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 0 && document.querySelector('#docs-nav-list [data-doc]').dataset.doc === 'how-do-i' && /second goal/i.test(document.getElementById('docs-nav-list').textContent)`, `"${q}": How do I comes first with the recipe`, 15000);
            const rows = await list();
            assert.equal(rows[0].doc, 'how-do-i', `"${q}": How do I is the first hit: ` + JSON.stringify(rows.slice(0, 4)));
            const firstApi = rows.findIndex(r => r.doc !== 'how-do-i' && /api/i.test(r.doc));
            const lastPlain = rows.map(r => r.doc).filter(d => !/api/i.test(d)).length - 1;
            assert.ok(firstApi < 0 || lastPlain < firstApi, `"${q}": the plain topics come before the API pages: ` + JSON.stringify(rows.map(r => r.doc)));
        }
        const text = await ev(`fetch('/api/agent-docs/how-do-i').then(r => r.json()).then(j => String(j.content || ''))`);
        assert.match(text, /## Give the team a second goal[\s\S]*Goals[\s\S]*\*\*New goal\*\*[\s\S]*\*\*Create goal\*\*/, 'the recipe names the Goals tab, New goal and Create goal');
        console.log('PASS How do I has the second-goal recipe and a search for goal finds it first, above the API pages');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
