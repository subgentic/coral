// The sidebar's agent list by keyboard (#10579, Desktop keyboard pass 18:10): the list is one Tab stop, Up and Down move between its rows (Home and End to the ends), Enter opens the agent and the keyboard lands in its message
// box, and a "Skip to message box" link is the first stop of the pane. 1280 px, isolated dev server, mock agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    const key = (k, code, text) => Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, ...(text ? { text } : {}) }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, code }));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`for (const n of ['alpha', 'beta', 'gamma']) window.__m.add(n + '-bot', 'A', 4, { sleeping: false }); true`);
        await sleep(800); // sleep-ok: a redraw settles over frames; there is no completion event
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item[data-session-id]').length >= 3`, 'the rows ' + await ev(`JSON.stringify([document.getElementById('live-sessions-list') && document.getElementById('live-sessions-list').innerHTML.slice(0, 300), (window.__qaState || {}).liveSessions && window.__qaState.liveSessions.length])`), 8000);
        const stops = () => ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].map(r => r.tabIndex)`);
        assert.deepEqual((await stops()).filter(t => t === 0).length, 1, `one Tab stop in the list: ${JSON.stringify(await stops())}`);
        const sid = () => ev(`document.activeElement.dataset.sessionId || document.activeElement.id`);
        const rows = await ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].map(r => r.dataset.sessionId)`);
        await ev(`document.querySelector('#live-sessions-list .session-group-item[tabindex="0"]').focus(); true`);
        const first = await sid();
        await key('ArrowDown', 'ArrowDown'); const second = await sid();
        assert.notEqual(second, first, 'Down moves to the next row');
        await key('ArrowDown', 'ArrowDown'); const third = await sid();
        assert.ok(new Set([first, second, third]).size === 3 && [first, second, third].every(x => rows.includes(x)), 'Down walks the rows');
        await key('ArrowUp', 'ArrowUp'); assert.equal(await sid(), second, 'Up moves back');
        await key('Home', 'Home'); assert.equal(await sid(), rows.includes(first) ? await ev(`document.querySelector('#live-sessions-list .session-group-item').dataset.sessionId`) : first, 'Home is the first row');
        await key('End', 'End'); assert.equal(await sid(), await ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].pop().dataset.sessionId`), 'End is the last row');
        assert.equal((await stops()).filter(t => t === 0).length, 1, 'still one Tab stop after moving');
        // a redraw keeps one stop, and it is the row the keyboard was on
        const onNow = await sid();
        await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [], removed: [] }); true`).catch(() => {});
        await ev(`import((window.__coralStatic || '/static/') + 'render.js').then(m => m.redrawLiveList && m.redrawLiveList()).then(() => true)`).catch(() => {});
        await sleep(400); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal((await stops()).filter(t => t === 0).length, 1, 'a redraw leaves one stop');
        assert.equal(await ev(`document.querySelector('#live-sessions-list .session-group-item[tabindex="0"]').dataset.sessionId`), onNow, 'the row the keyboard was on');

        // Enter opens the agent and the keyboard is in its message box
        await key('Enter', 'Enter', '\r');
        await waitFor(`document.activeElement && document.activeElement.id === 'command-input'`, 'the message box has the focus after Enter on a row', 8000);

        // the skip link: the first stop of the page (#10802), to the message box
        await ev(`document.querySelector('#live-sessions-list .session-group-item[tabindex="0"]').focus(); true`);
        const link = await ev(`(() => { const a = document.querySelector('body > .skip-link'); return a ? { text: a.textContent.trim(), first: !!(a.compareDocumentPosition(document.querySelector('#live-sessions-list')) & Node.DOCUMENT_POSITION_FOLLOWING) } : null; })()`);
        assert.deepEqual(link, { text: 'Skip to message box', first: true }, 'the page starts with the link');
        await ev(`document.querySelector('.skip-link').focus(); true`);
        assert.ok(await ev(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.width > 20 && r.left >= 0; })()`), 'it is shown while the keyboard is on it');
        await key('Enter', 'Enter', '\r');
        await waitFor(`document.activeElement && document.activeElement.id === 'command-input'`, 'Enter on the link lands in the message box', 5000);
        console.log('PASS Agent list: one Tab stop, Up and Down, Home and End, Enter lands in the message box, a skip link to it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
