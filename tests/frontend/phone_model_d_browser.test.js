// The phone's navigation model, slice D (#11236 approved, #11239): Computers is a top-level screen: the shared phone bar (phone_bar.js: ☰, the pill "Computers", the account), the floating bar with no tab lit (a place of the ☰ menu, #11472), and room under the
// last row for it. At 390 and 320 px, 100% and 200% text, light and dark. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = Object.assign(require('./helpers/wait').bind(ev), { coralReady: require('./helpers/wait').coralReady });
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'dark'], [390, 16, 'light'], [390, 32, 'dark'], [320, 16, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const tag = `${w}@${fs} ${theme}`;
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`getComputedStyle(document.getElementById('servers-view')).display !== 'none' && document.getElementById('servers-view').getClientRects().length > 0`, `${tag}: the Computers page`, 10000); await settle(500);
            const d = await ev(`(() => { const v = document.getElementById('servers-view'), bar = [...document.querySelectorAll('.phone-bar')].find(b => b.getClientRects().length), slot = document.querySelector('.phone-nav-slot.active'); return { type: document.body.dataset.phoneType, nav: getComputedStyle(document.getElementById('phone-nav')).display, lit: slot ? slot.dataset.phoneNav : null, pad: parseFloat(getComputedStyle(v).paddingBottom), bar: !!bar, title: bar ? bar.querySelector('.phone-bar-title').textContent.trim() : null, page: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.ok(d.type === 'top-level' && d.nav === 'flex' && d.lit === null && d.pad >= 100 && d.bar && d.title === 'Computers' && d.page, `${tag}: Computers is a top-level screen (shared bar, bar with no tab lit (a place of the ☰ menu, #11472), room under the content, no sideways scroll): ` + JSON.stringify(d));
            assert.equal(await ev(`document.querySelectorAll('#servers-view .servers-form-error').length`), 0, `${tag}: a Coral that is not a hub shows no red error on Computers (its list route answers 404: not a hub is not a failure, #11400)`);
            await shot(`model-d-computers-${w}-${fs}-${theme}`);
        }
        // a job's page: ONE primary action in the pinned footer: More and Run now; Edit and Turn off are in the More menu (Delete as before)
        await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('automations'); true`); await waitFor(`!!document.querySelector('#group-table-view button.dt-primary')`, 'the jobs list', 10000);
        await ev(`document.querySelector('#group-table-view button.dt-primary').click(); true`); await waitFor(`!!document.querySelector('#scheduler-detail .sched-actions')`, 'the job page', 10000); await settle(400);
        const foot = await ev(`(() => { const vis = e => e.getClientRects().length > 0; const bs = [...document.querySelectorAll('#scheduler-detail .sched-actions > .btn, #scheduler-detail .sched-actions > .sched-more > .btn')].filter(vis); return { names: bs.map(b => b.textContent.trim()), small: bs.filter(b => b.getBoundingClientRect().height < 44).length, primary: bs.filter(b => b.classList.contains('btn-primary')).length }; })()`);
        assert.deepEqual(foot.names, ['More', 'Run now'], 'the job footer holds More and the one primary action: ' + JSON.stringify(foot));
        assert.ok(foot.primary === 1 && foot.small === 0, 'one primary, both 44 px: ' + JSON.stringify(foot));
        await shot('model-d-job');
        await ev(`document.querySelector('#scheduler-detail .sched-more-btn').click(); true`); await settle(250);
        const menu = await ev(`[...document.querySelectorAll('#scheduler-detail .sched-more-menu .menu-item')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
        assert.deepEqual(menu, ['Edit', 'Turn off', 'Delete'], 'Edit and Turn off are in the More menu with Delete: ' + JSON.stringify(menu));
        // a workflow's page: the same single primary footer: More and Run; Edit with Agent, Edit, Duplicate and Delete are in the More menu
        await ev(`window.openAutomationsFolder('workflows'); true`); await waitFor(`!!document.querySelector('#group-table-view tbody tr[data-key] .dt-primary')`, 'the workflows list', 10000);
        await ev(`document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click(); true`); await waitFor(`!!document.querySelector('#wf-detail-container .wf-detail-actions')`, 'the workflow page', 10000); await settle(400);
        const wf = await ev(`(() => { const bs = [...document.querySelectorAll('#wf-detail-container .wf-detail-actions > .btn, #wf-detail-container .wf-detail-actions > .wf-more > .btn')].filter(b => b.getClientRects().length); return { names: bs.map(b => b.textContent.replace(/\\s+/g, ' ').trim().replace(/^(smart_toy|play_arrow)\\s*/, '')), small: bs.filter(b => b.getBoundingClientRect().height < 44).length }; })()`);
        assert.deepEqual(wf.names, ['More', 'Run'], 'the workflow footer holds More and the one primary action: ' + JSON.stringify(wf));
        assert.equal(wf.small, 0, 'both 44 px');
        await shot('model-d-workflow');
        await ev(`document.querySelector('#wf-detail-container .wf-more-btn').click(); true`); await settle(250);
        const wm = await ev(`[...document.querySelectorAll('#wf-detail-container .wf-more-menu .menu-item')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
        assert.deepEqual(wm, ['Edit with Agent', 'Edit', 'Duplicate', 'Delete'], 'the More menu holds the rest: ' + JSON.stringify(wm));
        // More (#11400, the v2.0.10 phone walk): the floating nav has Home, Inbox and Tasks, so the menu does not list them again; Computers is in it on every Coral (it is a top-level screen), with Automations, Analytics and Docs
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await settle(500);
        await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length).click(); true`); // the ☰ in the top bar opens the menu (the bar has no More slot, #11472)
        await waitFor(`!!document.querySelector('#nav-more-menu:not([hidden])')`, 'the More menu', 5000);
        const more = await ev(`[...document.querySelectorAll('#nav-more-menu .menu-item, #nav-more-menu .nav-more-item')].filter(e => e.getClientRects().length).map(e => (e.lastElementChild || e).textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(more.some(t => /Computers/.test(t)) && ['Docs', 'Settings'].every(n => more.some(t => t.includes(n))) && !more.some(t => /Automations|Analytics/.test(t)), 'More lists Computers, Docs and Settings, and not Automations or Analytics (they are the bar\'s tabs, #11535): ' + JSON.stringify(more));
        assert.ok(!more.some(t => /^(Home|Agents|Inbox)\b/.test(t)), 'and not Agents or Inbox, which the bottom bar has (Chats and Tasks are the Inbox folders at the top of the drawer): ' + JSON.stringify(more));
        await ev(`document.body.click(); true`);
        console.log('PASS the phone model, slice D: Computers');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
