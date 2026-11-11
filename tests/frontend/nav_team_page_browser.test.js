// The top bar marks the page you are on (#15449, Walk 16 L14): on a team page (opened from the sidebar, any tab) no item of the bar is marked current, the Inbox's did stay lit from the page before.
// Going back to a page marks that page's item again. 1280 px and a 390 px phone (its bottom bar's Inbox slot too), the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const lit = () => ev(`[...document.querySelectorAll('.top-nav-tab[aria-current], .top-nav-tab.active')].map(b => b.id)`);
    const slots = () => ev(`[...document.querySelectorAll('.phone-nav-slot.active, .phone-nav-slot[aria-current]')].map(b => b.dataset.phoneNav)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('#nav-tab-hub-inbox[aria-current="page"]')`, `${at}the Inbox is marked on the Inbox page`, 5000);
            await ev(`Promise.resolve(window.openTeamPage('nav-team-qa', { tab: 'goals' })).then(() => true)`);
            await waitFor(`!!document.querySelector('#team-page-view') && getComputedStyle(document.getElementById('team-page-view')).display !== 'none'`, `${at}the team page shows`, 8000);
            check((await lit()).length === 0, `${at}on a team page no item of the top bar is marked: ` + JSON.stringify(await lit()));
            if (mobile) check(!(await slots()).includes('nav-inbox'), `${at}the phone bar's Inbox slot is not lit on a team page: ` + JSON.stringify(await slots()));
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('#nav-tab-hub-inbox[aria-current="page"]')`, `${at}back on the Inbox page its item is marked again`, 5000);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('nav_team_page_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
