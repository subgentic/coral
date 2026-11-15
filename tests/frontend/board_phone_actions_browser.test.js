// The team page's Board tab, as the chat, on a phone (#7183, UI/UX's #7180 findings 4 and 6; on the team page since the board page went, #8157): the search and its buttons are one "Search" row that opens on a tap (a wider window shows the bar as before); each message's actions are one
// "..." that opens a sheet with Save for later and, set apart from it, Delete (Delete is never beside Save); the two jumps are items of the search bar's More menu: "Jump to first message" and "Jump to latest message". 390 px with touch, and 1280 px.
// Real isolated server, a board made through the API (and removed again). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { clearSaved } = require('./helpers/saved_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = `board-actions-${Date.now()}`;
    const api = async (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shown = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
    const open = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`localStorage.setItem('coral.board.view', 'chat'); (async () => { await fetch('/api/board/${board}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', job_title: 'QA', session_name: 'qa-s' }) }); for (const c of ['first message', 'second message']) await fetch('/api/board/${board}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', as: 'QA', content: c }) }); return true; })()`); // the chat view: this suite is about the chat rows' own "..." (the table's actions are board_table_browser's)
        await Page.navigate({ url: `${BASE}/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 2 && !!document.querySelector('#mb-tools .list-bar-bar')`, 'the board and its tools', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        console.log('390 px: the search row shown directly, one "..." per message');
        await open(390, true);
        assert.equal(await shown('#mb-tools .mb-search-toggle'), false, 'no Search row: the disclosure is gone (#7713)');
        assert.equal(await ev(`!!document.querySelector('.mb-search-toggle')`), false, 'and none is built');
        assert.equal(await shown('#mb-tools .list-bar-bar'), true, 'the search box and its icons are shown directly');
        assert.equal(await ev(`(() => { const r = document.querySelector('#mb-tools .list-bar-search').getBoundingClientRect(), t = document.querySelector('#mb-tools .list-bar-toggle').getBoundingClientRect(), m = document.querySelector('#mb-tools .list-bar-more-btn').getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (t.top + t.bottom) / 2) < 8 && r.right <= t.left + 1 && t.right <= m.left + 1 && t.height >= 31.5 && m.height >= 31.5; })()`), true, 'the field grows and the Filters and More icons (32 px or more) are at its right, on one line');
        assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, true, 'nothing scrolls sideways');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].filter(b => !b.hidden).map(b => b.textContent)`), ['Jump to first message', 'Jump to latest message'], 'the jumps are menu items of the More icon and say what they do (#7686)');
        assert.equal(await ev(`[...document.querySelectorAll('.mb-message-header .mb-delete-msg-btn')].filter(b => b.getClientRects().length).length`), 0, 'no Delete cross beside the time');
        assert.equal(await ev(`[...document.querySelectorAll('.mb-message-header .mb-save-btn')].filter(b => b.getClientRects().length).length`), 0, 'no Save bookmark drawn on an unsaved message');
        const more = await ev(`[...document.querySelectorAll('.mb-message-header .mb-msg-more')].map(b => ({ shown: b.getClientRects().length > 0, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width), name: b.getAttribute('aria-label') }))`);
        assert.ok(more.length >= 2 && more.every(m => m.shown && m.h >= 44 && m.w >= 44 && /^Actions for the message from QA/.test(m.name)), 'one 44 px "..." per message, named for its message: ' + JSON.stringify(more));
        assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, 'nothing scrolls sideways');
        if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/board-390-folded.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        await ev(`document.querySelector('.mb-message-header .mb-msg-more').focus(); document.querySelector('.mb-message-header .mb-msg-more').click(); true`);
        await waitFor(`!!document.querySelector('dialog.mb-actions-sheet[open]')`, 'the sheet', 3000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.mb-actions-sheet .mb-actions-item')].map(b => b.textContent)`), ['Save for later', 'Delete message', 'Close']);
        if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/board-390-sheet.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        const gap = await ev(`(() => { const items = [...document.querySelectorAll('.mb-actions-sheet .mb-actions-item')]; return Math.round(items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().bottom); })()`);
        assert.ok(gap >= 24, `Delete is set apart from Save (${gap} px between them)`);
        assert.ok(await ev(`[...document.querySelectorAll('.mb-actions-sheet .mb-actions-item')].every(b => b.getBoundingClientRect().height >= 43.5)`), 'every item is 44 px');
        assert.equal(await ev(`document.activeElement.textContent`), 'Save for later', 'focus is in the sheet, on its first item');
        await ev(`document.querySelectorAll('.mb-actions-sheet .mb-actions-item')[0].click(); true`);
        await waitFor(`!document.querySelector('dialog.mb-actions-sheet') && document.querySelector('.mb-message-header .mb-save-btn').getAttribute('aria-pressed') === 'true'`, 'the message saved', 6000);
        assert.equal(await ev(`!!document.activeElement.closest('.mb-message-header')`), true, 'focus stays on that message\'s header: the bookmark that Save just filled (the page focuses it) or the "..."');
        assert.equal(await shown('.mb-message-header .mb-save-btn[aria-pressed="true"]'), true, 'a saved message keeps its filled bookmark as its mark');
        await ev(`document.querySelector('.mb-message-header .mb-msg-more').click(); true`);
        await waitFor(`!!document.querySelector('dialog.mb-actions-sheet[open]')`, 'the sheet again', 3000);
        assert.equal(await ev(`document.querySelectorAll('.mb-actions-sheet .mb-actions-item')[0].textContent`), 'Remove from saved', 'the first item says what it will do now');
        await ev(`document.querySelectorAll('.mb-actions-sheet .mb-actions-item')[2].click(); true`);
        await waitFor(`!document.querySelector('dialog.mb-actions-sheet')`, 'Close', 3000);
        assert.equal(await ev(`document.activeElement.classList.contains('mb-msg-more')`), true, 'Close with nothing chosen: focus goes back to the "..." that opened the sheet');
        await ev(`document.querySelector('.mb-message-header .mb-save-btn[aria-pressed="true"]').click(); true`); // the saved mark is removed again: the test leaves nothing saved

        console.log('1280 px: the bar as before, no "..."');
        await open(1280, false);
        assert.equal(await ev(`!!document.querySelector('.mb-search-toggle')`), false, 'no Search row on a wide screen');
        assert.equal(await shown('#mb-tools .list-bar-bar'), true, 'the bar is shown as before');
        assert.equal(await ev(`[...document.querySelectorAll('.mb-msg-more')].filter(b => b.getClientRects().length).length`), 0, 'no "..." on a wide screen');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].filter(b => !b.hidden).map(b => b.textContent)`), ['Jump to first message', 'Jump to latest message']);
        console.log('PASS the board on a phone');
    } finally { await clearSaved(api).catch(() => {}); await removeBoards(ev, [board]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
