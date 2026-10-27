// The lazy modules of the bundled family make no stub requests (#8670, plan (c) of #8663). A tab's first visit used to cost its module and one stub for each
// startup module that module imports (Workflows 21 requests, Analytics 12: 36 over the seven main tabs); now a lazy module is built against the bundle's instance
// and a tab family is ONE file: Workflows is workflows.js (with its editor, run page and Build with Agent), Analytics is cost_dashboard.js (with its views, charts,
// agent page and the two team views). One instance of each module stays: a member asked for by importOnce or by URL, before or after its group, is the group's.
// Drives the real dashboard over CDP against an isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, sleep, PRELOAD } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await sleep(2500); // sleep-ok: the startup's own tasks run after the list renders; there is no event for "all started"
        const prefix = await ev('window.__coralStatic');
        assert.match(prefix, /^\/static\/bb\//, 'the page is bundled: ' + prefix);
        const seen = new Set(await ev(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)`));
        const fetched = async () => {
            const all = await ev(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)`);
            const fresh = all.filter(p => !seen.has(p) && p.startsWith(prefix) && p.endsWith('.js')).map(p => p.slice(prefix.length));
            all.forEach(p => seen.add(p));
            return fresh.sort();
        };
        const isStub = async m => {
            const text = await ev(`fetch(${JSON.stringify(prefix + m)}).then(r => r.text())`);
            return /^export \{[^}]*\} from '\.\.?\/[\w./-]+\.js';\s*$/.test(text) || text.trim() === 'export {};';
        };
        const visit = async (tab, want, ms = 3500) => {
            await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
            await sleep(ms); // sleep-ok: the tab's lazy modules load after the click; the requests are what is counted
            const got = await fetched();
            assert.deepEqual(got, want, `${tab}: the first visit fetched ${got.join(', ')}`);
            for (const m of got) assert.equal(await isStub(m), false, `${m} is a stub of a startup module: its first visit cost a stub request`);
            console.log(`   ✓ ${tab}: ${got.length} file(s), ${got.join(', ')}`);
        };

        console.log('1. A first visit is one file for a tab family, and no stub');
        await visit('workflows', ['workflows.js']);
        await visit('tokens', ['cost_dashboard.js']);
        await visit('docs', ['docs.js']);

        console.log('2. One instance: importOnce and the URL of a group member are the group\'s');
        const same = await ev(`(async () => { const base = window.__coralStatic; const { importOnce } = await import(base + 'import_once.js');
            const [ed, edUrl] = [await importOnce('./workflow_editor.js'), await import(base + 'workflow_editor.js')];
            const [av, avUrl] = [await importOnce('./analytics_views.js'), await import(base + 'analytics_views.js')];
            const wf = await importOnce('./workflows.js');
            return { editor: ed.saveWorkflow === edUrl.saveWorkflow && typeof ed.saveWorkflow === 'function', views: av.showViews === avUrl.showViews && typeof av.showViews === 'function', main: typeof wf.showWorkflowsTab === 'function' }; })()`);
        assert.deepEqual(same, { editor: true, views: true, main: true }, JSON.stringify(same));
        console.log('   ✓ the same functions by importOnce and by URL');

        console.log('3. A member asked for first (by URL) is still the one instance the group registers');
        const l = Page.loadEventFired(); await Page.navigate({ url: BASE }); await l;
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        const first = await ev(`(async () => { const base = window.__coralStatic; const { importOnce } = await import(base + 'import_once.js');
            const byUrl = await import(base + 'workflow_editor.js'); const byOnce = await importOnce('./workflow_editor.js'); const main = await importOnce('./workflows.js');
            return { stubFirst: byUrl.saveWorkflow === byOnce.saveWorkflow, mainLoaded: typeof main.selectWorkflow === 'function' }; })()`);
        assert.deepEqual(first, { stubFirst: true, mainLoaded: true }, JSON.stringify(first));
        console.log('   ✓ one instance whichever is asked for first');
        console.log('\nPASS the lazy modules make no stub requests and keep one instance');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
