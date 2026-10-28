// The team board with the keyboard up, a phone's 390 x 500 (Mobile tester's pass, #10081, #10088): (1) after a send or a viewport resize the board's messages sit at the newest message, and a message that arrives while the person has scrolled up is
// a 'Jump to latest' pill, not a jump; (2) the last message's own actions (Reply, Copy link, More) can be scrolled up out of the way of the composer; (3) the composer grows to about five lines before it scrolls; (4) while the person is typing the team's
// tabs, status line and the board's search and filter chips fold away, so the messages have the room (one slim row stays: the team's name and More). Drives Chrome over CDP through agent_view_harness.js on the isolated dev server; a board made through the API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'kb-up-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const post = (p, b) => ev(`fetch('/api/board/${BOARD}' + ${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(b)}) }).then(r => r.status)`);
    const list = () => ev(`(() => { const l = document.getElementById('mb-messages'); return { top: l.scrollTop, ch: l.clientHeight, sh: l.scrollHeight, atEnd: l.scrollHeight - l.scrollTop - l.clientHeight <= 4, rows: l.querySelectorAll('.mb-message').length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await post('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' });
        for (let i = 1; i <= 14; i++) await post('/messages', { subscriber_id: 'Boss', content: `Message number ${i} on the team board with a few more words so that it is a line of text.` });
        await ev(`window.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'messages' }).then(() => true)`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 12`, 'the messages', 15000);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the board settles at the newest message
        let l = await list();
        check(l.atEnd, `the board opens at the newest message: ${JSON.stringify(l)}`);

        // (1) the keyboard comes up (the viewport shrinks): still at the newest message
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the layout follows the resize
        l = await list();
        check(l.atEnd, `after the viewport shrinks to 390 x 500 the newest message is still in view: ${JSON.stringify(l)}`);
        // a send: the person types in the composer and sends; the list is at the newest message, with theirs
        await ev(`(() => { const i = document.getElementById('mb-post-input'); i.focus(); i.value = 'My own message sent from a phone with the keyboard up'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the composer follows its text
        await ev(`document.querySelector('#mb-board .mb-post-send-btn').click(); true`);
        await waitFor(`[...document.querySelectorAll('#mb-messages .mb-message')].some(m => /My own message sent from a phone/.test(m.textContent))`, 'the sent message in the list', 10000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the list scrolls
        l = await list();
        check(l.atEnd, `after a send the list is at the newest message, the person's own: ${JSON.stringify(l)}`);
        // scrolled up: a message that arrives is a pill, and the list does not move; the pill takes the person to it
        await ev(`document.getElementById('mb-messages').scrollTop = 0; true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
        await post('/messages', { subscriber_id: 'Boss', content: 'A newer message that arrives while the person reads older ones' });
        await waitFor(`[...document.querySelectorAll('#mb-messages .mb-message')].some(m => /A newer message that arrives/.test(m.textContent))`, 'the arrived message', 15000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the pill draws
        const pill = await ev(`(() => { const b = document.querySelector('.mb-new-pill-btn'), l = document.getElementById('mb-messages'); return { shown: !!b && !b.hidden && b.getClientRects().length > 0, text: b ? b.textContent.trim() : '', top: l.scrollTop }; })()`);
        check(pill.shown && /latest|new/i.test(pill.text) && pill.top < 40, `scrolled up, an arrived message is a pill and the list stays: ${JSON.stringify(pill)}`);
        await ev(`document.querySelector('.mb-new-pill-btn').click(); true`);
        await new Promise(r => setTimeout(r, 700)); // sleep-ok: the jump and the page settle
        { const j = await list(); check(j.atEnd, 'the pill takes the person to the newest message: ' + JSON.stringify(j)); }

        // (3) the composer grows to about five lines, then scrolls
        const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
        const box = async n => { await ev(`(() => { const i = document.getElementById('mb-post-input'); i.focus(); i.value = ${JSON.stringify(lines(n))}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the composer follows */ return ev(`(() => { const i = document.getElementById('mb-post-input'), cs = getComputedStyle(i); return { h: Math.round(i.getBoundingClientRect().height), line: parseFloat(cs.lineHeight) || 0, scrolls: i.scrollHeight > i.clientHeight + 1, max: cs.maxHeight }; })()`); };
        const b3 = await box(3), b5 = await box(5), b9 = await box(9);
        check(b5.h >= b3.h + 30, `the composer grows from 3 lines to 5: ${JSON.stringify([b3, b5])}`);
        check(b9.h <= b5.h + b5.line, `and stops at about five lines, then scrolls: ${JSON.stringify([b5, b9])}`);
        check(b9.scrolls, 'nine lines scroll inside the composer');

        // (4) typing: the tabs, status and the board's search and chips fold away; one slim row stays
        const shown = id => `(() => { const e = document.querySelector(${JSON.stringify(id)}); return !!e && e.getClientRects().length > 0; })()`;
        await ev(`document.getElementById('mb-post-input').focus(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the page folds
        check(!(await ev(shown('#team-tabs-row'))) && !(await ev(shown('#mb-tools'))), 'while typing the tabs and the board\'s search and chips are folded away');
        check(await ev(shown('#team-page-title')) && await ev(shown('#team-page-more')), 'the team\'s name and More stay, as one slim row');
        await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value = 'two words'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the composer follows
        const room = await ev(`document.getElementById('mb-messages').clientHeight`);
        check(room >= 190, `the messages have room while typing a short message (it was 78 px with the tabs, the search and the chips up): ${room} px`);
        await shot('board-keyboard-up-390x500');
        await ev(`document.getElementById('mb-post-input').blur(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the page unfolds
        check(await ev(shown('#team-tabs-row')) && await ev(shown('#mb-tools')), 'without the keyboard the tabs and the board\'s search and chips are back');

        // (2) the last message's own actions can be scrolled clear of the composer (nothing under it)
        await ev(`document.getElementById('mb-messages').scrollTop = document.getElementById('mb-messages').scrollHeight; true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
        await ev(`(() => { const rows = document.querySelectorAll('#mb-messages .mb-message'); const last = rows[rows.length - 1]; const tog = last.querySelector('button, [role=button], summary, .mb-toggle'); if (tog) tog.click(); return true; })()`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the row opens
        await ev(`document.getElementById('mb-messages').scrollTop = document.getElementById('mb-messages').scrollHeight; true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
        const acts = await ev(`(() => { const rows = [...document.querySelectorAll('#mb-messages .mb-message')], last = rows[rows.length - 1], b = [...last.querySelectorAll('button')].filter(x => /^(Reply|Copy link|More)$/.test(x.textContent.trim())), f = document.querySelector('.mb-post-form').getBoundingClientRect(); return { n: b.length, bottoms: b.map(x => Math.round(x.getBoundingClientRect().bottom)), composerTop: Math.round(f.top) }; })()`);
        check(acts.n >= 2 && acts.bottoms.every(x => x <= acts.composerTop), `the last message's actions end above the composer: ${JSON.stringify(acts)}`);
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the board with the keyboard up:\n  ' + problems.join('\n  '));
    console.log('PASS the board with the keyboard up');
})().catch(e => { console.error(e); process.exit(1); });
