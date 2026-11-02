// An agent row's open menu keeps the keyboard where it was when the live list redraws (#10786, the Hermes Agent Investigation's review): a person who tabbed to Rename in the open menu is still on Rename after the list is
// drawn again (the poll does that every few seconds), and the menu is still open; before this the redraw put the focus back on the row's "More actions" button, outside the menu, so the next key press started over. The menu is
// opened with a real mouse click, the focus moved into it with real Tab key events. 1280 and 390 px; the page's mocked agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const key = (k, code, vk) => Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const setList = () => ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
            await setList();
            await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn')`, at + 'the agent row', 10000);
            const p = await ev(`(() => { const e = document.querySelector('.session-group-item .sidebar-kebab-btn'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
            await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, at + 'the menu opens', 4000);
            await key('Tab', 'Tab', 9); await key('Tab', 'Tab', 9); // the first item, then the second (Rename)
            const where = () => ev(`(() => { const a = document.activeElement, m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); return { label: a ? (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) : '', inMenu: !!(m && a && m.contains(a)), open: !!m }; })()`);
            const before = await where();
            assert.deepEqual([before.label, before.inMenu, before.open], ['Rename', true, true], at + 'the keyboard is on Rename in the open menu: ' + JSON.stringify(before));
            await setList(); await ev(framesJs(4)); // the live list redraws while the keyboard is in the menu
            const after = await where();
            assert.ok(after.open, at + 'the menu is still open after the redraw: ' + JSON.stringify(after));
            assert.deepEqual([after.label, after.inMenu], ['Rename', true], at + 'and the keyboard is still on Rename, in the menu (it went to "' + after.label + '"): ' + JSON.stringify(after));
        }
    } finally { await client.close(); }
    console.log('sidebar_kebab_focus_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
