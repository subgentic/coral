// The Inbox's Tasks and Saved rows by keyboard alone (#9783, the v2.0.2 keyboard pass): Enter on a row opens the item and puts focus inside it (Back on a task, the heading on a saved message), and Escape returns to the list with focus on THAT row's button,
// at a mouse and on a phone (the mail rows). The Saved phone row lost its place: Escape landed on the hidden "Saved" heading because its button carried no data-id. 1280 and 390 px, the Inbox's census world.
const assert = require('node:assert/strict');
const { showTasksTab } = require('./helpers/tasks_tab.js');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;
const { coralReady, waitStable } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const KEYS = { Enter: [13, 'Enter'], Escape: [27, 'Escape'] };
    const key = async k => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : undefined; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code }); await new Promise(r => setTimeout(r, 150)); }; // sleep-ok: the key's handlers run
    const active = () => ev(`(() => { const e = document.activeElement; if (!e) return null; const r = e.getBoundingClientRect(); return { cls: String(e.className || ''), id: e.id || '', text: (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), visible: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }; })()`);
    try {
        await Page.enable(); await showTasksTab(Page); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, mobile] of [['1280', 1280, false], ['390', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(INBOX_WORLD);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            for (const tab of ['tasks', 'saved']) {
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('${tab}')).then(() => true)`);
                // The hidden Saved dock also has .dt-primary rows. Task paging can finish after that dock;
                // a page-wide query used to focus its invisible Agent 12 and send Enter to BODY (#19488).
                const rows = `[...document.querySelectorAll('#group-table-view[data-group="hub-inbox:${tab}"] .dt-table tbody tr .dt-primary')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden'; })`;
                await waitFor(`${rows}.length >= 2`, `${tag} ${tab}: visible folder rows`, 8000);
                assert.equal(await ev(`(() => { const b = ${rows}[1]; b.focus(); return document.activeElement === b; })()`), true, `${tag} ${tab}: the second visible folder row takes focus`);
                const before = await active();
                assert.ok(before.visible && /dt-primary/.test(before.cls), `${tag} ${tab}: focus is on the row before Enter`);
                await key('Enter');
                // The item is open when its Back is shown and stays so: before that, Escape is not "one level back" to the list but the Inbox's own Escape, which leaves for Agents (saved_marks.js looks for the Back link). At 20x CPU slowdown the key landed first (#19449).
                const backShown = `[...document.querySelectorAll('#inbox-page:not([hidden]) .goals-back, #inbox-page:not([hidden]) .back-link, #agentic-saved-detail-pane:not([hidden]) .back-link, .phone-title-row .back-link')].some(b => b.getClientRects().length > 0)`;
                await waitFor(backShown, `${tag} ${tab}: the item's Back is shown`, 15000);
                await waitStable(ev, backShown, `${tag} ${tab}: the item's Back stays`, 400, { timeout: 15000, accept: v => v === true });
                const inside = await active(); check(inside && inside.visible && !/dt-primary|dt-mail-open/.test(inside.cls), `${tag} ${tab}: Enter puts focus inside the item, visible: ${JSON.stringify(inside)}`);
                await key('Escape'); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list redraws
                const back = await active(); check(back && back.visible && back.text === before.text, `${tag} ${tab}: Escape puts focus back on the row it came from (${JSON.stringify(before.text)}): ${JSON.stringify(back)}`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(found, [], 'the Inbox rows by keyboard:\n  ' + found.join('\n  '));
    console.log('PASS the Inbox Tasks and Saved rows by keyboard');
})().catch(e => { console.error(e); process.exit(1); });
