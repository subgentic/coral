// #18620 (the Operator, rc4 preview: "what is all this?"): a Dismiss on a Getting started item is a row in Activity that names what was dismissed ("Dismissed Read the Coral guide"), not six
// identical "a row in Needs you" rows; the expanded row reads "You · this computer" (no empty part between the dots); and an intact record says nothing above the table.
// The real isolated server records the click from PUT /api/settings (the record is shared by the shard's other suites: only this run's own row is read, and the setting is put back).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const put = body => ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load();
        const before = await ev(`fetch('/api/settings').then(r => r.json()).then(s => String(s.inbox_welcome_done || ''))`);
        try {
            assert.equal(await put({ inbox_welcome_done: '' }), 200);
            assert.equal(await put({ inbox_welcome_done: 'guide' }), 200); // the guide item dismissed: one new id in the list
            await load();
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="activity"]')`, 'the Activity folder in the sidebar', 10000);
            await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="activity"]').click(); true`);
            await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:activity'`, 'the folder on screen', 10000);
            const mine = `[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-detail)')].filter(r => r.textContent.includes('Read the Coral guide'))`;
            await waitFor(`${mine}.length >= 1`, 'a row that names the item dismissed', 10000);
            const text = await ev(`${mine}[0].textContent.replace(/\\s+/g, ' ')`);
            assert.match(text, /Dismissed/); assert.doesNotMatch(text, /a row in Needs you/, 'the row names the item, not the kind: ' + text);
            await ev(`${mine}[0].querySelector('[data-key="item"] button').click(); true`);
            await waitFor(`!!document.querySelector('.activity-expanded')`, 'the expanded row', 5000);
            const open = await ev(`[...document.querySelectorAll('.activity-expanded p')].map(p => p.textContent).join(' | ')`);
            assert.ok(/You · this computer/.test(open), 'the expanded row reads You · this computer: ' + open);
            assert.ok(!/· ·|·\s*·/.test(open), 'no empty part between the dots: ' + open);
            assert.equal(await ev(`document.querySelector('.activity-check')`), null, 'an intact record says nothing above the table');
            console.log('PASS activity dismiss names the item: row, expanded row, no header line');
        } finally { await put({ inbox_welcome_done: before }).catch(() => {}); }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
