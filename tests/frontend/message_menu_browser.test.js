// A message the person sent, and an agent's reply, each have a small menu (#10159, #10540): Copy and Save for later, and nothing else (Send to another agent was taken out, #10682, the Operator). The menu opens by keyboard (Enter on
// the button, Escape back to the button) and the button is there on a phone at 390. A real chat of mocked agents.
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
                { const list = Object.values(window.__m.agents).map(a => window.__m.entry(a)); window._coralSetLiveSessions(list); } localStorage.setItem('coral-live-view-mode', 'chat'); return true; })()`);
            await ev(`window.selectLiveSession('qa', 'claude', 'qa-sid', 'local'); true`); // by its real session id, as the list opens it
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
            const canSave = await ev(`!!document.querySelector(${JSON.stringify(btn)}).closest('.chat-bubble').querySelector('.chat-save-btn')`);
            assert.equal(items.some(x => /^(Save for later|Remove from saved)$/.test(x)), canSave, `${w}: Save for later is in the menu when the message has a save button (${canSave}): ${JSON.stringify(items)}`);
            assert.ok(items.every(x => x === 'Copy' || /^(Save for later|Remove from saved)$/.test(x)), `${w}: the menu is Copy and Save for later, nothing that sends it to another agent (the Operator, #10682): ${JSON.stringify(items)}`);
            // the menu a person's own message opens is as solid as a reply's (#10768): a surface of the shared menu colour, in both themes, not the page showing through
            for (const theme of ['dark', 'light']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
                await waitFor(`document.getAnimations().length === 0`, `${w}/${theme}: the menu has finished opening`, 3000);
                const own = await ev(`(() => { const m = document.getElementById('chat-msg-menu'), c = getComputedStyle(m), t = document.createElement('div'); t.className = 'menu'; t.hidden = false; document.body.append(t); const shared = getComputedStyle(t).backgroundColor; t.remove(); return { bg: c.backgroundColor, opacity: c.opacity, shared, shadow: c.boxShadow !== 'none', border: c.borderTopWidth }; })()`);
                assert.ok(/^rgb\(/.test(own.bg) && own.opacity === '1', `${w}/${theme}: the sent message's menu has a solid background: ${JSON.stringify(own)}`);
                assert.ok(own.shadow && own.border !== '0px', `${w}/${theme}: and the shared menu's edge and shadow: ${JSON.stringify(own)}`);
            }
            await ev(`document.documentElement.setAttribute('data-theme', 'dark'); true`);
            await waitFor(`document.getAnimations().length === 0`, `${w}: the menu has finished opening`, 3000); // a shot of a menu mid-fade shows the reply through it
            await shot(`message-menu-${w}`);
            // Escape gives the focus back to the button
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`document.getElementById('chat-msg-menu').hidden`, `${w}: Escape closes it`, 3000);
            assert.equal(await ev(`document.activeElement === document.querySelector(${JSON.stringify(btn)})`), true, `${w}: and the focus is back on the button`);
            const rbtn = `#live-history-messages .chat-bubble.assistant .chat-msg-menu-btn`;
            assert.equal(await ev(`!!document.querySelector(${JSON.stringify(rbtn)})`), true, `${w}: a reply has the menu button`);
            if (mobile) assert.ok(await ev(`(() => { const b = document.querySelector(${JSON.stringify(rbtn)}); const r = b.getBoundingClientRect(); return getComputedStyle(b).opacity === '1' && r.width >= 20 && r.right <= innerWidth; })()`), `${w}: the reply's button is shown and on screen`);
            const overlap = await ev(`(() => { const b = document.querySelector(${JSON.stringify(rbtn)}).closest('.chat-bubble'); const bs = [...b.querySelectorAll('.chat-copy-btn, .chat-save-btn, .chat-msg-menu-btn')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect()); const hit = []; for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (bs[i].left < bs[j].right && bs[j].left < bs[i].right && bs[i].top < bs[j].bottom && bs[j].top < bs[i].bottom) hit.push([i, j]); return hit; })()`);
            assert.deepEqual(overlap, [], `${w}: a reply's Copy, Save and menu buttons do not sit on each other`);
            await ev(`window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; true`);
            await ev(`document.querySelector(${JSON.stringify(rbtn)}).click(); true`);
            await waitFor(`!document.getElementById('chat-msg-menu').hidden && document.getElementById('chat-msg-menu').getClientRects().length > 0`, `${w}: the reply's menu opens`, 4000);
            const rItems = await ev(`[...document.querySelectorAll('#chat-msg-menu [role=menuitem]')].map(b => b.textContent.trim())`);
            assert.equal(rItems[0], 'Copy', `${w}: a reply's menu starts with Copy: ${JSON.stringify(rItems)}`);
            assert.ok(rItems.every(x => x === 'Copy' || /^(Save for later|Remove from saved)$/.test(x)), `${w}: a reply's menu is Copy and Save for later only: ${JSON.stringify(rItems)}`);
            assert.equal(await ev(`document.querySelectorAll('#chat-msg-menu .chat-msg-menu-head, #chat-msg-menu [role=group]').length`), 0, `${w}: no heading or team groups`);
            const bg = await ev(`(() => { const c = getComputedStyle(document.getElementById('chat-msg-menu')); return { bg: c.backgroundColor, opacity: c.opacity }; })()`);
            assert.ok(/^rgb\(/.test(bg.bg) && bg.opacity === '1', `${w}: the menu's background is solid (the reply's words do not show through): ${JSON.stringify(bg)}`);
            await ev(`document.querySelector('#chat-msg-menu [role=menuitem]').click(); true`);
            await waitFor(`window.__copied !== null`, `${w}: Copy copies`, 3000);
            const want = await ev(`import((window.__coralStatic || '/static/') + 'chat_messages.js').then(m => m.bubbleSource.get(document.querySelector(${JSON.stringify(rbtn)}).closest('.chat-bubble')).trim())`);
            assert.equal(await ev(`window.__copied`), want, `${w}: it copies the reply as the agent wrote it`);
        }
        console.log('\nPASS the message menu is Copy and Save for later');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
