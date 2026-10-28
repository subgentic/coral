// A message the person sent has a small menu (#10159, Desktop tester #10082): Copy, Save for later and Send to another agent. Sending to another agent puts the text in that agent's message box and never sends it; the
// menu opens by keyboard (Enter on the button, arrows, Escape back to the button) and the button is there on a phone at 390. A real chat of two mocked agents; the send route is watched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { const real = window.fetch; window.__sends = []; window.fetch = (u, o = {}) => { if (/\\/api\\/sessions\\/live\\/[^/]+\\/send$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST') { window.__sends.push(String(u)); return new Promise(() => {}); } return real(u, o); };
                window.__m.add('qa', 'A', 6, { sleeping: false, session_id: 'qa-sid' }); window.__m.add('fe', 'B', 2, { sleeping: false, session_id: 'fe-sid' });
                window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); return true; })()`);
            await select('qa');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, `${w}: the chat`, 15000);
            const bubbleText = await ev(`(() => { const b = document.querySelector('#live-history-messages .chat-bubble.human'); return b ? b.querySelector('.message-text').innerText.trim() : null; })()`);
            assert.ok(bubbleText, `${w}: a message the person sent`);
            const btn = `#live-history-messages .chat-bubble.human .chat-msg-menu-btn`;
            assert.equal(await ev(`!!document.querySelector(${JSON.stringify(btn)})`), true, `${w}: it has the menu button`);
            if (mobile) assert.ok(await ev(`(() => { const b = document.querySelector(${JSON.stringify(btn)}); const r = b.getBoundingClientRect(); return getComputedStyle(b).opacity === '1' && r.width >= 20 && r.right <= innerWidth; })()`), '390: the button is shown (no hover on a phone) and on the screen');
            // by keyboard: focus the button, Enter opens, the items are Copy, Save for later (when it can be saved), then the agents
            await ev(`{ const b = document.querySelector(${JSON.stringify(btn)}); b.focus(); } true`);
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`!document.getElementById('chat-msg-menu')?.hidden && document.getElementById('chat-msg-menu')?.getClientRects().length > 0`, `${w}: the menu opens by keyboard`, 4000);
            const items = await ev(`[...document.querySelectorAll('#chat-msg-menu [role=menuitem]')].map(b => b.textContent.trim())`);
            assert.equal(items[0], 'Copy', `${w}: Copy first: ${JSON.stringify(items)}`);
            assert.ok(items.includes('FE Alpha') || items.some(x => /fe/i.test(x)), `${w}: the other agent is a choice: ${JSON.stringify(items)}`);
            assert.ok(!items.some(x => /qa/i.test(x) && x !== 'Copy'), `${w}: the agent that is open is not offered: ${JSON.stringify(items)}`);
            assert.equal(await ev(`document.getElementById('chat-msg-menu').querySelector('[role=menuitem]') === document.activeElement`), true, `${w}: the first item has the focus`);
            await shot(`message-menu-${w}`);
            // Escape gives the focus back to the button
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`document.getElementById('chat-msg-menu').hidden`, `${w}: Escape closes it`, 3000);
            assert.equal(await ev(`document.activeElement === document.querySelector(${JSON.stringify(btn)})`), true, `${w}: and the focus is back on the button`);
            // the other agent already has an unsent draft: the message is added after it, a blank line between; it is not replaced (#10159)
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { const row = m.state.liveSessions.find(s => s.session_id === 'fe-sid'); m.saveSessionDraft(m.sessionKey(row), 'half typed'); return true; })`);
            // pick the other agent: its box holds the text, nothing was sent
            await ev(`document.querySelector(${JSON.stringify(btn)}).click(); true`);
            await waitFor(`!document.getElementById('chat-msg-menu').hidden`, `${w}: the menu opens by click`, 3000);
            await ev(`[...document.querySelectorAll('#chat-msg-menu [role=menuitem]')].find(b => /fe/i.test(b.textContent)).click(); true`);
            await waitFor(`T.state.currentSession && T.state.currentSession.session_id === 'fe-sid'`, `${w}: the other agent opens`, 8000);
            await waitFor(`document.getElementById('command-input').value === ${JSON.stringify('half typed\n\n' + bubbleText)}`, `${w}: its box holds its draft, a blank line, then the message`, 5000);
            assert.deepEqual(await ev(`window.__sends`), [], `${w}: nothing was sent`);
        }
        console.log('\nPASS a sent message has a menu: Copy, Save, and Send to another agent that fills the other box and sends nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
