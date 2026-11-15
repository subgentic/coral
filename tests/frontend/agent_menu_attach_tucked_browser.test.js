// The agent menu keeps Attach out of the first click's way (#17492, walk 71 L15: a click aimed at Archive toasted "Terminal opened"). Attach opens a real Terminal window on the computer, so it sits
// under More, where no click can land until More is opened; and Archive stays under the pointer while the menu opens and the live list redraws. Real mouse events, 1280 and 390 px, the page's mocked agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const setList = () => ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'menu_help.js').then(() => true)`); // the help lines module is in, as it is a moment after the page loads
            await setList();
            await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn')`, 'the agent row', 10000);
            const click = async p => { await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); };
            const kebab = await ev(`(() => { const r = document.querySelector('.session-group-item .sidebar-kebab-btn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            await click(kebab);
            await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, `${w} px: the menu opens`, 4000);
            const probe = () => ev(`(() => { const m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const items = [...m.querySelectorAll('.overflow-menu-item, .menu-item')];
                const arch = items.find(e => /^(Archive|Unarchive)/.test(e.textContent.trim())); const att = items.find(e => /^Attach$/.test(e.textContent.trim()));
                const r = arch && arch.getBoundingClientRect(); const at = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { archive: !!arch, x: r && Math.round(r.left + r.width / 2), y: r && Math.round(r.top + r.height / 2), hit: !!(at && arch.contains(at)), attachClickable: !!(att && att.getClientRects().length > 0) }; })()`);
            const first = await probe(); await ev(framesJs(23)); // the menu has settled (menu_help adds its lines a tick after the click)
            const settled = await probe();
            assert.ok(first.archive, `${w} px: the menu has Archive`);
            assert.deepEqual([settled.x, settled.y], [first.x, first.y], `${w} px: Archive does not move under the pointer while the menu opens`);
            assert.ok(first.hit, `${w} px: Archive is what is under its own centre`);
            assert.equal(first.attachClickable, false, `${w} px: Attach cannot be clicked until More is opened`);
            await ev(framesJs(6));
            await setList();
            await ev(framesJs(6));
            const later = await probe(); 
            assert.deepEqual([later.x, later.y, later.hit, later.attachClickable], [first.x, first.y, true, false], `${w} px: Archive stays where it was and Attach stays tucked after the list redraws with the same agents`);
            await ev(`(() => { const m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); [...m.querySelectorAll('[data-on-click="team-menu-more"]')][0].click(); return true; })()`);
            await ev(framesJs(3));
            assert.equal((await probe()).attachClickable, true, `${w} px: More shows Attach`);
        }
    } finally { await client.close(); }
    console.log('agent_menu_attach_tucked_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
