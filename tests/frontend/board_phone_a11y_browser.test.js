// The team page's Board tab on a 390 px phone for a person using touch, a screen reader or the light theme (#6566, ported from the old board page in #8157): no two visible buttons of the page share a name,
// the More menu's items (the board's Select, Export, Pause and Delete) hold 4.5:1 in the light theme ("Select" was 4.4:1). A real board over the API with two subscribers. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'phone-board-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [id, t] of [['Boss', 'Orchestrator'], ['dev-1', 'Developer']]) assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'Please check the release notes.' }), 200);
        await Page.navigate({ url: `${BASE}/team/${B}/messages` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 1`, 'the message', 15000);

        // names: the team page's visible buttons (the Board tab with its header, tabs, pills, switch and search): none shares a name with another
        const dup = await ev(`(() => { const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; const name = e => (e.getAttribute('aria-label') || e.textContent).replace(/\\s+/g, ' ').trim();
            const names = [...document.querySelectorAll('#team-page-view button')].filter(vis).map(name).filter(Boolean);
            return { dup: [...new Set(names.filter((n, i) => names.indexOf(n) !== i))], n: names.length, header: names.filter(n => n === 'Actions').length, tabs: names.filter(n => /^(?:More tabs|.+, more tabs)$/.test(n)).length }; })()`);
        assert.ok(dup.n >= 8, 'the team page has its buttons: ' + JSON.stringify(dup));
        assert.deepEqual(dup.dup, [], 'no two visible buttons on the team page share a name');
        assert.deepEqual([dup.header, dup.tabs], [1, 1], "the header's button is named Actions (it was More, the same word as the tab row's, #10942) and the tab row's is named More tabs, or '<open tab>, more tabs' while a tab behind it is open (#8648; Board is behind it since #8791): " + JSON.stringify(dup));

        // the More menu in the light theme: the team page's More holds the board's Select, Export, Pause and Delete
        await installAudit(ev); await setTheme(ev, 'light');
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`document.getElementById('team-page-more').getAttribute('aria-expanded') === 'true' && !document.getElementById('team-page-more-menu').hidden`, 'the More menu', 5000);
        const menu = await auditRegion(ev, ['#team-page-more-menu']);
        assert.ok(menu.checked > 0 && !menu.fails.length, 'the More menu holds 4.5:1 in the light theme: ' + JSON.stringify(menu.fails).slice(0, 400));
        assert.ok(await ev(`['mb-select-btn', 'mb-export-btn', 'mb-pause-btn', 'mb-delete-btn'].every(id => document.getElementById(id).closest('#team-page-more-menu'))`), 'the board actions are in the team page\'s More');
        await ev(`document.getElementById('team-page-more').click(); true`);

        // the Subscribers sheet and its history links went with the board page's header: the team's members are its Agents tab (agents_tab_phone suites hold their 44 px targets)
        console.log('PASS the phone team page: names are distinct, the More menu holds contrast');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
