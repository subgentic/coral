// A reply's footer on a phone (#10904, the phone pass: the menu sat over Save, whose dot showed beside the bookmark, and the time wrapped under the icons): Copy, Save, the menu and the time are four controls
// side by side that do not overlap, and the time is one line. QA's :8476 chat had the real footer (copy x 355, save 307, menu 301, time 29 px wide); the harness's mocked chat has no Save or time, so they are
// added the way the page draws them. 390 px, touch; the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: layout settles
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('foot', 'F', 6, { sleeping: false }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await select('foot');
        await waitFor(`window.__rendered && window.__rendered().length >= 4`, 'the chat', 15000); await sleep(600); // sleep-ok: the chat's footer is laid out
        const r = await ev(`(() => { const b = document.querySelector('#live-history-messages .chat-bubble.assistant');
            if (!b.querySelector('.chat-save-btn')) { const s = document.createElement('button'); s.type = 'button'; s.className = 'btn btn-quiet btn-icon btn-xs chat-save-btn'; s.setAttribute('aria-label', 'Save for later'); s.innerHTML = '<span class="material-icons" aria-hidden="true">bookmark_border</span>'; b.insertBefore(s, b.querySelector('.chat-copy-btn')); }
            if (!b.querySelector('.message-time')) { const t = document.createElement('time'); t.className = 'message-time'; t.textContent = '01:31'; b.append(t); }
            const box = q => { const e = b.querySelector(q), x = e.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom, h: x.height, vis: getComputedStyle(e).display !== 'none' && x.width > 0 }; };
            const tm = b.querySelector('.message-time'), rg = document.createRange(); rg.selectNodeContents(tm); const lines = new Set([...rg.getClientRects()].map(x => Math.round(x.top))).size;
            return { save: box('.chat-save-btn'), copy: box('.chat-copy-btn'), menu: box('.chat-msg-menu-btn'), time: { ...box('.message-time'), lines } }; })()`);
        const names = ['save', 'copy', 'menu', 'time'], over = [];
        for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) { const a = r[names[i]], c = r[names[j]]; if (a.vis && c.vis && a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) over.push(names[i] + ' over ' + names[j]); }
        assert.deepEqual(over, [], 'the footer controls do not overlap: ' + JSON.stringify(r));
        assert.equal(r.time.lines, 1, 'the time is one line: ' + JSON.stringify(r.time));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
