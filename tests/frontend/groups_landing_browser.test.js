// A tab that opens on its page shows every group its sidebar has (#7722, the #7720 audit's findings 8 and 10): Workflows has Active and Paused groups (Jobs became a folder of Automations, Goal #74), and the page they open on used to
// list the first group only (Active 2) while the sidebar counted 3. Now the page lists each group under its own head with its own count, so the two agree; a group's name in the sidebar still opens that group
// alone. 1280 px, isolated dev server, the workflows and jobs of the census world stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD }); // the world is there from the first load: the Jobs list is read once at start
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const page = () => ev(`(() => { const v = document.getElementById('group-table-view'); if (!v || v.offsetParent === null) return null; return { heads: [...v.querySelectorAll('.group-table-head')].map(h => h.textContent.replace(/\\s+/g, '')), rows: v.querySelectorAll('tbody tr').length, ids: [...v.querySelectorAll('#group-table-title')].length }; })()`);
        const side = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(h => h.textContent.replace(/\\s+/g, ''))`);
        for (const [tab, listSel, label] of [['workflows', '#wf-nav-list .sgroup-header', 'Workflows']]) {
            await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
            await waitFor(`document.querySelectorAll(${JSON.stringify(listSel)}).length === 2 && !!document.querySelector('#group-table-view tbody tr')`, `${label}: the sidebar's groups and the page`, { timeout: 10000, diag: `({ groups: document.querySelectorAll(${JSON.stringify(listSel)}).length, rows: document.querySelectorAll('#group-table-view tbody tr').length, tab: document.body.getAttribute('data-nav-tab') })` });
            const heads = await side(listSel);
            assert.deepEqual(heads, ['Active2', 'Paused1'], `${label}: the sidebar has two groups ${JSON.stringify(heads)}`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, `${label}: the page to list all three`, 5000).catch(() => {});
            const p = await page();
            assert.equal(p.rows, 3, `${label}: the page lists all 3 items, not the first group's 2 ${JSON.stringify(p)}`);
            assert.deepEqual(p.heads.map(h => h.replace(/(smart_toy)?BuildwithAgent$/, '')), ['Active2', 'Paused1'], `${label}: each group has its head and count on the page, the same as the sidebar's ${JSON.stringify(p)}`);
            assert.equal(p.ids, 1, `${label}: one element carries the page's title id ${JSON.stringify(p)}`);
            // the groups' tables line up: the same columns at the same x, and a gap above each next head
            const al = await ev(`(() => { const v = document.getElementById('group-table-view'), ts = [...v.querySelectorAll('table')]; const xs = ts.map(t => [...t.querySelectorAll('th')].map(h => Math.round(h.getBoundingClientRect().left)));
                const heads = [...v.querySelectorAll('.group-table-head')], first = ts[0].closest('.group-table-scroll') || ts[0]; return { xs, gap: Math.round(heads[1].getBoundingClientRect().top - first.getBoundingClientRect().bottom) }; })()`);
            assert.deepEqual(al.xs[0], al.xs[1], `${label}: the columns of the two tables start at the same x ${JSON.stringify(al)}`);
            assert.ok(al.gap >= 16, `${label}: a gap of at least 16 px above the second group's head (${al.gap}px)`);
            // a group's name opens that group alone
            await ev(`document.querySelectorAll(${JSON.stringify(listSel)})[1].click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, `${label}: the Paused group opened alone`, 5000);
            const one = await page();
            assert.deepEqual(one.heads.map(h => h.replace(/(smart_toy)?BuildwithAgent$/, '')), ['Paused1'], `${label}: the group's own page ${JSON.stringify(one)}`);
        }
        console.log('PASS the Workflows page lists every group the sidebar has');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
