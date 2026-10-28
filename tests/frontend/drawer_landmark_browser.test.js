// The sidebar is a landmark with the right name, and a shut drawer is not in the tree (#10306 LOW, #10452): in a narrow desktop window the sidebar is a drawer, off screen when shut but still in the accessibility tree, a
// complementary landmark called "Agents" even on the Inbox, Automations, Analytics and Docs tabs, where it holds their folders. Now: shut, the drawer is out of the tree (inert); open, it is a complementary landmark named for
// the tab it shows (Agents, Inbox, Automations, Analytics, Docs); in a wide window the same landmark is there, named for the tab. Read from the accessibility tree at 853 x 480 and 1280 x 800. Drives Chrome over CDP through
// agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axNodes } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const NAMES = { agents: 'Agents', 'hub-inbox': 'Inbox', automations: 'Automations', tokens: 'Analytics', docs: 'Docs' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await client.Accessibility.enable();
        const sidebars = async () => (await axNodes(client.Accessibility)).filter(n => n.role && n.role.value === 'complementary').map(n => (n.name && n.name.value) || '').filter(n => n !== 'Details');
        for (const [w, h] of [[853, 480], [1280, 800]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem('coral-sidebar-collapsed-rail', '0'); true`);
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            for (const tab of Object.keys(NAMES)) {
                await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await new Promise(r => setTimeout(r, 700)); // sleep-ok: the tab draws
                if (w < 1024) {
                    check((await sidebars()).length === 0, `${w}: with the drawer shut no sidebar landmark is in the tree on ${tab}: ${JSON.stringify(await sidebars())}`);
                    await ev(`document.querySelector('.tablet-sidebar-toggle').click(); true`); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the drawer slides in
                    const open = await sidebars();
                    check(open.length === 1 && open[0] === NAMES[tab], `${w}: open, the drawer is one complementary landmark named ${NAMES[tab]} on ${tab}: ${JSON.stringify(open)}`);
                    await ev(`document.querySelector('.tablet-sidebar-toggle').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the drawer slides out
                } else {
                    const lm = await sidebars();
                    check(lm.length === 1 && lm[0] === NAMES[tab], `${w}: the sidebar is one complementary landmark named ${NAMES[tab]} on ${tab}: ${JSON.stringify(lm)}`);
                }
            }
        }
        // every top tab gives the sidebar a name (#10489, from #10452's review): a tab not in the fixed list takes its own title, never the name the last tab left
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const tabs = await ev(`[...document.querySelectorAll('.top-nav-tab[data-arg]')].map(b => ({ tab: b.dataset.arg, title: b.dataset.label || b.textContent.trim() }))`);
        check(tabs.length >= 5, `the census sees the top tabs: ${JSON.stringify(tabs)}`);
        const extra = [{ tab: 'zz-new-tab', title: 'A New Tab' }]; // a tab added later, not in the fixed list: the button is made here, the way the next one will be
        await ev(`(() => { const b = document.createElement('button'); b.className = 'tab top-nav-tab'; b.id = 'nav-tab-zz-new-tab'; b.dataset.arg = 'zz-new-tab'; b.textContent = 'A New Tab'; b.hidden = true; document.querySelector('.top-nav-tab').after(b); return true; })()`);
        for (const { tab, title } of [...tabs, ...extra]) {
            await ev(`document.body.setAttribute('data-nav-tab', ${JSON.stringify(tab)}); true`); await new Promise(r => setTimeout(r, 150)); // sleep-ok: the observer runs
            const got = await ev(`document.querySelector('.sidebar').getAttribute('aria-label') || ''`);
            const want = NAMES[tab] || title;
            check(got === want, `${tab}: the sidebar's name is ${JSON.stringify(want)} (it is ${JSON.stringify(got)})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the sidebar landmark:\n  ' + problems.join('\n  '));
    console.log('PASS the sidebar is a named landmark and a shut drawer is out of the tree');
})().catch(e => { console.error(e); process.exit(1); });
