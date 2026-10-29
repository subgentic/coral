// The job form loads when it is first opened (#10218): if that load fails (a dropped request, the Hub tunnel), the click says so with the usual toast ("Could not load the job form. Check the connection to Coral, then try again.")
// and nothing is left unhandled; the next click, with the connection back, opens the form. 1280 px, isolated dev server over CDP: the module's request is blocked, then allowed.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Network.enable();
        await client.Network.setBlockedURLs({ urls: ['*job_form*'] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.__unhandled = 0; window.addEventListener('unhandledrejection', () => { window.__unhandled++; }); true`);
        await ev(`window.showJobModal(); true`);
        await waitFor(`/Could not load the job form/.test(document.body.innerText)`, 'the failure toast', 8000);
        check('a failed load of the job form says so with a toast', true);
        await sleep(300); // sleep-ok: an unhandled rejection is reported after the toast
        check('and leaves nothing unhandled', (await ev(`window.__unhandled`)) === 0, String(await ev(`window.__unhandled`)));
        check('no form opened', !(await ev(`!!document.querySelector('.job-type-btn')`)));
        await client.Network.setBlockedURLs({ urls: [] });
        await ev(`window.showJobModal(); true`);
        await waitFor(`!!document.querySelector('.job-type-btn')`, 'the form once the connection is back', 10000);
        check('the next click, with the connection back, opens the form', true);
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} load failure checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
