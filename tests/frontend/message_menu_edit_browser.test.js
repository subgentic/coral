// A sent message's menu gets "Edit as a new message" and never opens over the message box (#10533 point 2, the Desktop tester): the text goes in the box to change and send (after what is already typed; nothing is sent), and
// the menu of a message near the box opens above its button instead of over the box. 1280 x 800 and a short 1100 x 520 window, a real chat of a mocked agent; the send route is watched.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [1100, 520]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { const real = window.fetch; window.__sends = []; window.fetch = (u, o = {}) => { if (/\\/api\\/sessions\\/live\\/[^/]+\\/send$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST') { window.__sends.push(String(u)); } return real(u, o); };
                window.__m.add('qa', 'A', 6, { sleeping: false, session_id: 'qa-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); return true; })()`);
            await ev(`window.selectLiveSession('qa', 'claude', 'qa-sid', 'local'); true`);
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, `${w}: the chat`, 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the chat scrolls to its newest message
            const sel = `#live-history-messages .chat-bubble.human .chat-msg-menu-btn`;
            const text = await ev(`(() => { const bs = [...document.querySelectorAll('#live-history-messages .chat-bubble.human')]; return bs[bs.length - 1].querySelector('.message-text').innerText.trim(); })()`);
            await ev(`(() => { const bs = [...document.querySelectorAll(${JSON.stringify(sel)})]; bs[bs.length - 1].scrollIntoView({ block: 'end' }); bs[bs.length - 1].click(); return true; })()`);
            await waitFor(`!document.getElementById('chat-msg-menu')?.hidden && document.getElementById('chat-msg-menu')?.getClientRects().length > 0`, `${w}: the menu opens`, 5000);
            const items = await ev(`[...document.querySelectorAll('#chat-msg-menu [role=menuitem]')].map(b => b.textContent.trim())`);
            assert.ok(items.includes('Edit as a new message'), `${w}: the menu offers Edit as a new message: ` + JSON.stringify(items));
            const geo = await ev(`(() => { const m = document.getElementById('chat-msg-menu').getBoundingClientRect(), c = document.getElementById('command-pane').getBoundingClientRect(); return { menu: [Math.round(m.top), Math.round(m.bottom)], box: [Math.round(c.top), Math.round(c.bottom)], over: m.bottom > c.top + 1 && m.top < c.bottom - 1 && m.right > c.left && m.left < c.right }; })()`);
            assert.equal(geo.over, false, `${w}: the menu is not over the message box: ` + JSON.stringify(geo));
            await ev(`document.getElementById('command-input').value = 'half typed'; [...document.querySelectorAll('#chat-msg-menu [role=menuitem]')].find(b => /^Edit as a new message$/.test(b.textContent.trim())).click(); true`);
            await waitFor(`document.getElementById('command-input').value === ${JSON.stringify('half typed\n\n' + text)}`, `${w}: the box holds what was typed, a blank line, then the message`, 4000);
            assert.equal(await ev(`document.activeElement === document.getElementById('command-input')`), true, `${w}: the box has the focus`);
            assert.deepEqual(await ev(`window.__sends`), [], `${w}: nothing was sent`);
        }
        console.log('PASS Edit as a new message, and the menu stays off the message box');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
