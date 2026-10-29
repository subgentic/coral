// The sidebar team menu's Delete team loads the board's code when it is chosen (#10318, #10282's rebase): if that load fails (a dropped request, the Hub tunnel), the click says so with the usual toast
// ("Could not load the board. Check the connection to Coral, then try again."), leaves nothing unhandled and opens no dialog; the next click, with the connection back, opens the Delete team dialog. 1280 px, isolated dev server over CDP:
// the module's request is blocked, then allowed. The menu item is a stand-in carrying the action and the team name the real one carries.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const choose = () => ev(`(() => { const b = document.createElement('button'); b.setAttribute('data-on-click', 'team-delete'); b.setAttribute('data-board', 'no-such-team'); document.body.append(b); b.click(); b.remove(); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Network.enable();
        await client.Network.setBlockedURLs({ urls: ['*message_board*'] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__unhandled = 0; window.addEventListener('unhandledrejection', () => { window.__unhandled++; }); true`);
        await choose();
        await waitFor(`/Could not load the board/.test(document.body.innerText)`, 'the failure toast', 8000);
        check('a failed load of the board says so with a toast', true);
        await sleep(300); // sleep-ok: an unhandled rejection is reported after the toast
        check('and leaves nothing unhandled', (await ev(`window.__unhandled`)) === 0, String(await ev(`window.__unhandled`)));
        await client.Network.setBlockedURLs({ urls: [] });
        await choose();
        await waitFor(`!!document.querySelector('.modal-overlay, [role="dialog"], .modal')`, 'a dialog once the connection is back', 10000);
        check('the next click, with the connection back, opens the dialog', true);
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} load failure checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
