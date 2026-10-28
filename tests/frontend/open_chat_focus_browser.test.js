// Opening an agent's chat puts the keyboard somewhere (#9794, #9783's open item): the chat is the page after Enter on Open chat, so focus is not left on the page body.
// At a mouse the composer has it (the person came to type); on a phone no keyboard pops up, so the chat's heading has it. axName of the focused element says where it is.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280 px, a mouse', 1280, 820, false], ['390 px, a phone', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('focus-a', 'P', 4, { sleeping: false, session_id: 'focus-a-id' }); true`);
            await ev(`document.body.focus(); import(${S} + 'sessions.js').then(m => m.selectLiveSession('focus-a', 'claude', 'focus-a-id', undefined, { focusChat: true })).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, label + ': the chat shows', 8000);
            const where = await ev(`(() => { const a = document.activeElement; return { id: a && a.id, tag: a && a.tagName, visible: !!a && a.getClientRects().length > 0 }; })()`);
            const want = mobile ? 'session-name' : 'command-input';
            await waitFor(`document.activeElement && document.activeElement.id === '${want}'`, `${label}: focus is on #${want}, not ${JSON.stringify(where)}`, 4000);
            await ev(`document.activeElement.setAttribute('data-ax-probe', ''); true`);
            const ax = await axName(client, '[data-ax-probe]');
            assert.ok(ax && ax.name !== undefined && (mobile ? ax.role === 'heading' : /textbox|combobox/.test(ax.role)), `${label}: the focused element is named ${JSON.stringify(ax)}`);
            // the sidebar's way in (no option) leaves focus on the row that was used
            await ev(`(() => { const b = document.createElement('button'); b.id = 'row-stand-in'; b.textContent = 'row'; document.body.append(b); b.focus(); })()`);
            await ev(`import(${S} + 'sessions.js').then(m => m.selectLiveSession('focus-a', 'claude', 'focus-a-id')).then(() => true)`);
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: a late focus move would have landed by now
            assert.equal(await ev(`document.activeElement.id`), 'row-stand-in', label + ': selecting from the sidebar leaves focus on the row');
            if (!mobile) { // the sidebar's row (the old behaviour, #9794): a click puts the cursor in the composer, Enter on the row does not move focus
                const rowSel = `[data-on-click="session-open"][data-session-id="focus-a-id"] .row-btn`;
                await ev(`(() => { const ul = document.getElementById('live-sessions-list'); ul.innerHTML = '<li class="session-group-item" data-session-id="focus-a-id" data-server="local" data-on-click="session-open" data-name="focus-a" data-agent-type="claude"><button type="button" class="row-btn">focus-a</button></li>'; return true; })()`);
                await waitFor(`!!document.querySelector('${rowSel}') && document.querySelector('${rowSel}').getClientRects().length > 0`, label + ': the agent has a sidebar row', 8000);
                // what the row's handler passes: a mouse click says pointer, Enter (a click with no pointer) does not
                await ev(`(() => { const o = window.selectLiveSession; window.__opts = []; window.selectLiveSession = (...a) => { window.__opts.push(!!(a[4] && a[4].pointer)); return o(...a); }; return true; })()`);
                const pt = await ev(`(() => { const r = document.querySelector('${rowSel}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
                await waitFor(`window.__opts.length === 1`, label + ': the click reached the handler', 4000);
                await ev(`document.querySelector('${rowSel}').focus(); true`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                await waitFor(`window.__opts.length === 2`, label + ': Enter reached the handler', 4000);
                assert.deepEqual(await ev(`window.__opts`), [true, false], label + ': a click is a pointer open, Enter is not');
                // and a pointer open puts the cursor in the composer from wherever focus was (here a stand-in outside the list)
                await ev(`document.getElementById('row-stand-in').focus(); import(${S} + 'sessions.js').then(m => m.selectLiveSession('focus-a', 'claude', 'focus-a-id', undefined, { pointer: true })).then(() => true)`);
                await waitFor(`document.activeElement && document.activeElement.id === 'command-input'`, label + ': a pointer open puts the cursor in the composer', 4000);
            }
            console.log('PASS ' + label + ': focus is on ' + want);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
