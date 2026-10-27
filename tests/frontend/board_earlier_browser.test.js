// Messages: earlier messages load on scroll-up, with no button or count line on load (#7762, the operator: "only show this when they scroll up, not on load").
// On load the board shows the newest page and neither "Load N earlier messages (M remaining)" nor "Showing N of M messages"; scrolling to near the top loads the page before (50), the row that was at
// the top stays in place, "Loading earlier messages…" is there only while the page is out, a screen reader hears "50 earlier messages loaded", "Start of the board" is the last line once the first
// message is loaded, and the keyboard's Jump to first message (the board search's First) still gets there. Drives Chrome over CDP against the isolated dev server, the board's messages answered
// by a stand-in (board_window_browser.test.js is the pattern).
'use strict';

const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');

const B = 'earlier-board-7762';
const TOTAL = 130; // three pages: 50 + 50 + 30
// alternating senders: a row that starts a group keeps its name line when the page before is added
const msg = id => ({ id, subscriber_id: id % 2 ? 'worker-a' : 'worker-b', job_title: id % 2 ? 'Worker A' : 'Worker B', content: `message ${id} ` + 'lorem ipsum dolor sit amet '.repeat(6), created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, id)).toISOString() });
const all = Array.from({ length: TOTAL }, (_, i) => msg(i + 1));

function page(q) {
    const limit = Number(q.get('limit')) || 50;
    const rows = q.has('before_id') ? all.filter(m => m.id < Number(q.get('before_id'))).slice(-limit) : all.slice(-limit);
    return { messages: rows, total: all.length, before_count: rows.length ? all.filter(m => m.id < rows[0].id).length : 0 };
}

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Fetch } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const C = `document.getElementById('mb-messages')`;
    const counts = () => ev(`window.__coral.boardCounts()`);
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        // The message pages are synthetic, but the team must exist: the team page checks
        // /artifacts for board_not_found before showing its panels (#8848).
        const homeLoaded = Page.loadEventFired();
        await Page.navigate({ url: BASE + '/' });
        await homeLoaded;
        await coralReady();
        assert.equal(await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'scroll-fixture', job_title: 'Scroll fixture' }) }).then(r => r.status)`), 200, 'the isolated board exists before opening its message panel');
        let hold = false, pending = null; // hold: an earlier page's answer waits until released, to see the line while it is out
        safePaused(client, ({ requestId, request }) => {
            const q = new URL(request.url).searchParams;
            const body = Buffer.from(JSON.stringify(page(q))).toString('base64');
            const answer = () => Fetch.fulfillRequest({ requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body }).catch(() => {});
            if (hold && q.has('before_id')) pending = answer; else answer();
        });
        await Fetch.enable({ patterns: [{ urlPattern: `*/api/board/${B}/messages/all*` }] });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            const loaded = Page.loadEventFired();
            await Page.navigate({ url: `${BASE}/board/${B}` });
            await loaded;
            await coralReady();
            await waitFor(`window.__coral && window.__coral.boardCounts && window.__coral.boardCounts().shown === 50`, 'the newest page');
            await waitFor(`(() => { const c = ${C}; return c.scrollHeight > c.clientHeight * 2 && c.scrollHeight - c.scrollTop - c.clientHeight < 80; })()`, 'a board scrolled to the bottom'); // a phone's last row can end a pixel past 50
            console.log(`${tag}: nothing on load`);
            let n = await counts();
            assert.equal(await ev(`${C}.querySelectorAll('.mb-load-earlier, .mb-message-count, .mb-earlier-line').length`), 0, 'no button, no count line, no line at all on load');
            assert.ok(!(await ev(`${C}.textContent`)).match(/Load \d+ earlier|Showing \d+ of/), 'no such words on the page');
            assert.deepEqual([n.shown, n.total, n.notLoaded], [50, TOTAL, TOTAL - 50]);

            console.log(`${tag}: scrolling to the top loads 50 and keeps the row in place`);
            const top = await ev(`(() => { const c = ${C}; c.scrollTop = 0; const r = c.querySelector('.mb-message'); return { id: r.dataset.messageId, y: r.getBoundingClientRect().top }; })()`);
            await waitFor(`window.__coral.boardCounts().shown === 100`, 'the page before, from scrolling');
            const kept = await ev(`(() => { const r = ${C}.querySelector('[data-message-id="${top.id}"]'); return { y: r.getBoundingClientRect().top, st: ${C}.scrollTop }; })()`);
            assert.ok(Math.abs(kept.y - top.y) < 2 && kept.st > 0, `the message that was at the top stays there (${top.y} -> ${kept.y})`);
            assert.equal(await ev(`${C}.querySelectorAll('.mb-load-earlier, .mb-message-count').length`), 0, 'still no button or count');
            assert.equal(await ev(`document.getElementById('mb-earlier-status').textContent`), '50 earlier messages loaded.', 'a screen reader is told');

            console.log(`${tag}: Loading... is there only while a page is out, and Start of the board when none is left`);
            hold = true;
            const y0 = await ev(`(() => { ${C}.scrollTop = 0; return ${C}.querySelector('.mb-message').getBoundingClientRect().top; })()`);
            await waitFor(`!document.getElementById('mb-earlier-loading').hidden`, 'the loading line');
            assert.equal(await ev(`document.getElementById('mb-earlier-loading').textContent`), 'Loading earlier messages\u2026');
            assert.equal(await ev(`document.getElementById('mb-earlier-status').textContent`), 'Loading earlier messages\u2026', 'a screen reader hears that it is loading');
            assert.equal(await ev(`getComputedStyle(document.getElementById('mb-earlier-loading')).position`), 'absolute', 'it floats: it takes no room');
            assert.equal(await ev(`${C}.querySelector('.mb-message').getBoundingClientRect().top`), y0, 'nothing moves while it is there');
            hold = false;
            if (pending) { await pending(); pending = null; }
            await waitFor(`window.__coral.boardCounts().shown === ${TOTAL}`, 'the first page');
            assert.equal(await ev(`document.getElementById('mb-earlier-loading').hidden`), true, 'the loading line is gone once the page is in');
            await waitFor(`!!${C}.querySelector('.mb-earlier-line')`, 'the end line');
            assert.equal(await ev(`${C}.querySelector('.mb-earlier-line').textContent`), 'Start of the board');
            assert.equal(await ev(`${C}.firstElementChild.classList.contains('mb-earlier-line')`), true, 'it is the first line of the list');
            assert.match(await ev(`document.getElementById('mb-earlier-status').textContent`), /30 earlier messages loaded\. This is the start of the board\./);
            assert.equal(await ev(`getComputedStyle(${C}.querySelector('.mb-earlier-line')).fontWeight`), '400', 'quiet: regular weight');

            console.log(`${tag}: the keyboard's Jump to first message gets to the start`);
            await ev(`window.location.reload(); true`);
            await coralReady();
            await waitFor(`window.__coral.boardCounts && window.__coral.boardCounts().shown === 50`, 'the newest page again');
            // Jump to first message is in the board toolbar's More menu: open it and press it, as the keyboard does
            await ev(`(() => { const more = [...document.querySelectorAll('#mb-tools button')].find(b => /^More\\b/.test((b.getAttribute('aria-label') || b.textContent).trim())); more.click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('[role="menuitem"], .list-bar-menu button')].some(b => /Jump to first message/.test(b.textContent))`, 'the More menu');
            await ev(`[...document.querySelectorAll('[role="menuitem"], .list-bar-menu button')].find(b => /Jump to first message/.test(b.textContent)).click(); true`);
            await waitFor(`window.__coral.boardCounts().shown === ${TOTAL} && ${C}.scrollTop < 5`, 'the first message');
            assert.equal(await ev(`document.activeElement && document.activeElement.dataset.messageId`), '1', 'focus is on the first message');
        }
        console.log(`\nAll earlier-messages checks passed`);
    } finally { try { await Fetch.disable(); await removeBoards(ev, [B]); } catch { /* the cleanup report names a leak */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
