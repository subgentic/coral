// The board search's current match stays in view when the layout shifts after the jump (#14881: under a slow CPU, board_search_browser had the match marked and focused but scrolled out of view, 5 of 10 at CPU x6): the jump scrolls to
// the match once, and rows or counts that arrive a moment later move it away. A shift is forced here right after the match is marked (a tall block above it, as late rows or an opened thread would be); the match must still be in view a
// moment later, until the person scrolls. The board's messages come from the isolated server. 1280 px.
'use strict';
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const BOARD = 'bkeep-' + Date.now().toString(36);
const N = 160;
const message = i => ({ from: 'dev-' + (i % 4), content: i % 9 === 0 ? 'Status ' + i + ': finished the review of the retry budget' : 'Update ' + i + ': still working on the thing, with a few words so the row has some height ' + 'lorem ipsum dolor sit amet '.repeat(3) });

(async () => {
    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Input, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const { removeBoards } = require('./helpers/board_cleanup');
    const fails = [];
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window._coralSetLiveSessions === 'function'`, 'the app hooks', { timeout: 10000 });
        await ev(`(async () => { for (let i = 0; i < ${N}; i++) { const m = ${JSON.stringify(Array.from({ length: N }, (_, i) => message(i)))}[i]; const r = await fetch('/api/board/${BOARD}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: m.from, content: m.content }) }); if (!r.ok) throw new Error('seed ' + i); } return true; })()`);
        await ev(`window.selectBoardProject(${JSON.stringify(BOARD)}); true`);
        await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 50`, 'the latest page', { timeout: 15000 });
        // the forced shift: the moment a row becomes the search target, a tall block goes in above it (after the jump's own scroll was asked for)
        await ev(`(() => { const c = document.getElementById('mb-messages'); window.__shifts = 0;
            new MutationObserver(recs => { for (const r of recs) if (r.target.classList && r.target.classList.contains('chat-search-target') && window.__shifts < 3) { window.__shifts++; const s = document.createElement('div'); s.className = 'zz-shift'; s.style.cssText = 'height:2400px;flex:none'; c.insertBefore(s, c.firstElementChild); } })
                .observe(c, { attributes: true, attributeFilter: ['class'], subtree: true }); return true; })()`);
        await ev(`document.querySelector('#bm-search').focus(); true`); await Input.insertText({ text: 'retry' });
        await waitFor(`document.querySelector('#mb-tools .mb-search-results')?.textContent.startsWith('1 of ')`, 'the first result', { timeout: 15000 });
        await waitFor(`window.__shifts >= 1`, 'the forced shift happened', { timeout: 8000 });
        const IN_VIEW = `(() => { const c = document.getElementById('mb-messages'); const cur = c.querySelector(':scope > .mb-message-current'); if (!cur) return false; const a = cur.getBoundingClientRect(), b = c.getBoundingClientRect(); return a.top >= b.top - 2 && a.bottom <= b.bottom + 2; })()`;
        const ok = await waitFor(IN_VIEW, 'the match in view after the shift', { timeout: 6000 }).then(() => true, () => false);
        if (!ok) fails.push('the current match is not in view after a layout shift that came right after the jump: ' + JSON.stringify(await ev(`(() => { const c = document.getElementById('mb-messages'); const cur = c.querySelector(':scope > .mb-message-current'); const a = cur && cur.getBoundingClientRect(), b = c.getBoundingClientRect(); return { top: a && Math.round(a.top - b.top), bottom: a && Math.round(a.bottom - b.top), view: Math.round(b.height), scrollTop: Math.round(c.scrollTop), shifts: window.__shifts }; })()`)));
        // the person scrolls: the page lets go (a later shift does not pull the match back under their hands)
        await ev(`(() => { const c = document.getElementById('mb-messages'); c.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true })); c.scrollTop += 300; return true; })()`);
        const after = await ev(`document.getElementById('mb-messages').scrollTop`);
        await new Promise(r => setTimeout(r, 700)); // sleep-ok: a negative: a pull-back would have happened by now
        const later = await ev(`document.getElementById('mb-messages').scrollTop`);
        if (Math.abs(later - after) > 60) fails.push(`after the person scrolled, the board moved again by itself (${after} -> ${later})`);
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    if (fails.length) { console.error('FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
    console.log('board_search_keeps_match_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
