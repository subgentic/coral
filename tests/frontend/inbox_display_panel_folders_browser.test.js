// The Inbox's Display panel holds Saved's Type, From and Sort ("Any type", "Any conversation", "Oldest saved") and is for the Saved folder only (#10817: the operator saw them under Needs you).
// The panel's open flag is one stored setting, so a person who left it open on Saved must not see it under any other folder. 1280 px, the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const PANEL = `document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-panel]')`;
    const shown = () => ev(`(() => { const p = ${PANEL}; return !!p && p.getClientRects().length > 0 && /Any conversation|Oldest saved|Newest saved/.test(p.textContent); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
        await ev(`document.querySelector('.view-list-item[data-key="saved"]').click(); true`);
        await waitFor(`!!document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-button]') && document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-button]').getClientRects().length > 0`, 'Saved has its Display button', 8000);
        await ev(`document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-button]').click(); true`); // the person opens Display on Saved and leaves it open
        for (const key of ['saved', 'needs', 'tasks', 'goals', 'artifacts', 'saved']) {
            await ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
            if (key === 'saved') await waitFor(`(() => { const p = ${PANEL}; return !!p && p.getClientRects().length > 0 && /Any conversation|Oldest saved|Newest saved/.test(p.textContent); })()`, 'Saved: its Filters and Sort', 5000);
            else await new Promise(r => setTimeout(r, 600)); // sleep-ok: the folder opens and the panel follows
            assert.equal(await shown(), key === 'saved', `${key}: Saved's Filters and Sort are ${key === 'saved' ? '' : 'not '}on screen`);
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
