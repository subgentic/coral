// The child cdp_navigation_never_loads_browser.test.js starts with the runner's preload (#352): it connects to the tab LOAD_WAIT_TARGET, navigates to LOAD_WAIT_URL (a page that never loads)
// and waits for its load, then, by mode (argv[2]):
//   wait    waits for good (its parent closes the tab under it): the preload must make it exit non-zero
//   exit    calls process.exit(0) with the wait still open: the exit check must make that non-zero
//   raced   races the wait against 300 ms, closes its client and exits 0: a wait the suite was done with is not a failure
'use strict';
const CDP = require('chrome-remote-interface');

(async () => {
    const mode = process.argv[2];
    const client = await CDP({ port: Number(process.env.CDP_PORT), target: process.env.LOAD_WAIT_TARGET });
    const { Page } = client;
    await Page.enable();
    await Promise.race([Page.navigate({ url: process.env.LOAD_WAIT_URL }), new Promise(r => setTimeout(r, 3000))]); // sleep-ok: the navigate of a page that never loads may not answer
    const wait = Page.loadEventFired();
    console.log('waiting');
    if (mode === 'wait') { await wait; console.log('the load came'); return; }
    if (mode === 'exit') { setTimeout(() => process.exit(0), 300); await wait; return; } // sleep-ok: the exit comes while the wait is open
    if (mode === 'raced') { await Promise.race([wait, new Promise(r => setTimeout(r, 300))]); await client.close(); process.exit(0); } // sleep-ok: the race's other side
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
