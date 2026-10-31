// The phone bar's Tasks (#11401 f, from the Mobile Beta Tester's walk): it opens the Tasks table, and the pill at the top says "Tasks", not "Inbox" (the Inbox's own name stayed in the pill while the Tasks table was open).
// The bar lights Tasks there (it lit Inbox). Inbox says Inbox again, and Tasks again says Tasks. 390 px, the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const title = () => ev(`[...document.querySelectorAll('.phone-bar-title')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const tap = id => ev(`document.querySelector('[data-phone-nav="${id}"]').click(); true`);
        const drawerTasks = async () => { await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length).click(); true`); await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden]) .nav-drawer-folder')`, 'the drawer opens', 6000); await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder')].find(b => b.querySelector('.nav-drawer-label').textContent === 'Tasks').click(); true`); }; // Tasks is a row of the drawer now (#11535), the bar has none
        await tap('nav-inbox');
        await waitFor(`[...document.querySelectorAll('.phone-bar-title')].some(e => e.getClientRects().length && /^Inbox$/.test(e.textContent.trim()))`, 'the pill says Inbox for the Inbox', 8000);
        await drawerTasks();
        await waitFor(`!!document.querySelector('#group-table-view h2, #group-table-view .group-table-head h2')`, 'the Tasks table is open', 8000);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table's heading is drawn after the view switches
        await shot('phone-tasks-title-390');
        assert.equal(await title(), 'Tasks', 'the pill says Tasks while the Tasks table is open: ' + await title());
        const lit = () => ev(`[...document.querySelectorAll('.phone-nav-slot.active')].map(e => e.dataset.phoneNav).join(',')`);
        assert.equal(await lit(), 'nav-inbox', 'the Tasks page is the Inbox\'s folder, so the bar lights Inbox (the bar has no Tasks tab, #11535): ' + await lit());
        // the Inbox's own tab changes (the strip above the table): the page is no longer the Tasks page, so the pill and the bar say Inbox again (QA Reviewer 2's MUST)
        await ev(`[...document.querySelectorAll('#group-table-view .view-list-name')].find(b => /^Goals/.test(b.textContent.trim())).click(); true`);
        await waitFor(`[...document.querySelectorAll('.phone-bar-title')].some(e => e.getClientRects().length && /^Inbox$/.test(e.textContent.trim()))`, 'the pill says Inbox once the Inbox tab is Goals', 8000);
        assert.equal(await lit(), 'nav-inbox', 'the bar lights Inbox once the Inbox tab is Goals: ' + await lit());
        await drawerTasks();
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the Tasks table again
        assert.equal(await title(), 'Tasks', 'Tasks again after the detour: ' + await title());
        await tap('nav-inbox');
        await waitFor(`[...document.querySelectorAll('.phone-bar-title')].some(e => e.getClientRects().length && /^Inbox$/.test(e.textContent.trim()))`, 'Inbox says Inbox again', 8000);
        assert.equal(await lit(), 'nav-inbox', 'and Inbox lights Inbox: ' + await lit());
        await drawerTasks();
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the second visit to the table
        assert.equal(await title(), 'Tasks', 'and Tasks says Tasks again: ' + await title());
        console.log('PASS the phone bar: Tasks says Tasks, Inbox says Inbox');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
