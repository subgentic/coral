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
    const label = () => ev(`(() => { const a = document.activeElement; return a ? (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) : ''; })()`);
    // a key press that the menu has not taken yet (the redraw of the list, or the menu's key handlers still attaching, swallows it) is pressed again until the keyboard moves: what is under test is where the keyboard stays, not the first press
    const trail = [];
    const pressMoves = async (k, code, vk) => { const was = await label(); for (let i = 0; i < 6; i++) { await key(k, code, vk); for (let j = 0; j < 8; j++) { await new Promise(r => setTimeout(r, 50)); const now = await label(); if (now !== was) { trail.push(`${k}: ${was} -> ${now} (press ${i + 1})`); return; } } } trail.push(`${k}: stayed on ${was}`); }; // sleep-ok: polls for the keyboard to move
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const setList = () => ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
            await setList();
            await waitFor(`!!document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-btn')`, at + 'the agent row', 10000);
            const clickIt = async () => { const q = await ev(`(() => { const e = document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-btn'); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`); await Input.dispatchMouseEvent({ type: 'mouseMoved', x: q.x, y: q.y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 }); };
            const isOpen = () => ev(`(() => { const m = document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()`); // this row's menu, not another row's (the team's)
            // The click is made where the row's button is once the list has stopped moving (the team's card draws after the agent list and shifts it: a click at a stale place opened the team's menu); a click that did not open this row's menu is made again after the other menu is closed
            const rectOf = () => ev(`(() => { const e = document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-btn'); const r = e && e.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top)].join() : ''; })()`);
            for (let t = 0; t < 4 && !(await isOpen()); t++) {
                await ev(`document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-btn').scrollIntoView({ block: 'center' }); true`);
                for (let j = 0, prev = ''; j < 40; j++) { const now = await rectOf(); if (now && now === prev) break; prev = now; await new Promise(r => setTimeout(r, 100)); } // sleep-ok: waits for the button to stop moving
                await clickIt();
                for (let j = 0; j < 10 && !(await isOpen()); j++) await new Promise(r => setTimeout(r, 50)); // sleep-ok: the menu opens
                if (!(await isOpen())) await key('Escape', 'Escape', 27);
            }
            await waitFor(`(() => { const m = document.querySelector('.session-group-item[data-session-id="w-sid"] .sidebar-kebab-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()`, at + 'the menu opens', 4000);
            await ev(`import((window.__coralStatic || '/static/') + 'import_once.js').then(m => m.importOnce('./kebab_keys.js')).then(() => true)`); // the menu's keys load on its first opening: wait for them before pressing any
            await pressMoves('Tab', 'Tab', 9); await pressMoves('ArrowDown', 'ArrowDown', 40); await pressMoves('ArrowDown', 'ArrowDown', 40); // Tab enters the first item (Sleep since #16371), Down twice goes to the third (Rename), after Open agent tab; Tab inside the menu closes it (#15445)
            const where = () => ev(`(() => { const a = document.activeElement, m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); return { label: a ? (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) : '', inMenu: !!(m && a && m.contains(a)), open: !!m }; })()`);
            const before = await where();
            assert.deepEqual([before.label, before.inMenu, before.open], ['Rename', true, true], at + 'the keyboard is on Rename in the open menu: ' + JSON.stringify(before) + ' ' + JSON.stringify(trail));
            await setList(); await ev(framesJs(4)); // the live list redraws while the keyboard is in the menu
            const after = await where();
            assert.ok(after.open, at + 'the menu is still open after the redraw: ' + JSON.stringify(after));
            assert.deepEqual([after.label, after.inMenu], ['Rename', true], at + 'and the keyboard is still on Rename, in the menu (it went to "' + after.label + '"): ' + JSON.stringify(after));
        }
    } finally { await client.close(); }
    console.log('sidebar_kebab_focus_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
