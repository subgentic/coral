// Pausing a team is visible and works at the first click (#15331, walk 22 H1-H3). From a tab that is NOT the Board (its code was not loaded, so the first click did nothing): the Actions item says Pause team, one click
// pauses, a toast says so, the header says Paused, a line under it says "Paused since HH:MM: agents get new messages when you resume" with a Resume team button, and the item now says Resume team. A message posted
// while paused is in the board at once, marked "Queued: delivered on resume", and the mark goes when the team resumes. Real board on the isolated dev server (removed again); run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'pz-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const menuItem = () => ev(`document.getElementById('mb-pause-btn')?.textContent.trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-11111111-2222-3333-4444-555555555555' })).status < 300);

        console.log('1. From the Tasks tab (the Board code not loaded), the first click pauses');
        await load(`/team/${B}/tasks`);
        await waitFor(`!!document.getElementById('team-page-more') && document.getElementById('team-page-view').getClientRects().length > 0`, 'the team page', 15000);
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`/^Pause team$/.test(document.getElementById('mb-pause-btn')?.textContent.trim() || '')`, 'the item says Pause team', 10000);
        await ev(`document.getElementById('mb-pause-btn').click(); true`);
        await waitFor(`!!document.getElementById('team-pause-bar') && !document.getElementById('team-pause-bar').hidden`, 'the pause line', 10000); // the line is the one place that says Paused (#16361): no toast, no header word
        assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t => /paused/i.test(t.textContent))`), false, 'no toast repeats it');
        assert.equal((await api('GET', `/api/board/${B}/paused`)).body.paused, true, 'the server says paused after ONE click');
        console.log('   ✓');

        console.log('2. The header says Paused, the line says since when and how to resume, the item says Resume team');
        assert.notEqual(await ev(`document.getElementById('team-page-status')?.textContent.trim()`), 'Paused', 'the header does not repeat it');
        assert.equal(await ev(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n, c = 0; while ((n = w.nextNode())) { const e = n.parentElement; if (/paused/i.test(n.nodeValue) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden') c++; } return c; })()`), 1, 'Paused is on the page once');
        await waitFor(`!!document.getElementById('team-pause-bar') && !document.getElementById('team-pause-bar').hidden`, 'the pause line', 10000);
        const line = await ev(`document.getElementById('team-pause-bar').textContent`);
        assert.match(line, /^Paused since \d{1,2}:\d{2}.*: agents get new messages when you resume\.\s*Resume team$/, line);
        assert.equal(await menuItem(), 'Resume team');
        console.log('   ✓');

        console.log('3. A message posted while paused is in the board at once, marked Queued');
        await ev(`document.getElementById('team-tab-messages').click(); true`);
        await waitFor(`!!document.getElementById('mb-post-input')`, 'the composer', 15000);
        await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value = 'please read this later'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await ev(`document.querySelector('#team-panel-messages [data-on-click="mb-post"]').click(); true`);
        await waitFor(`/please read this later/.test(document.getElementById('mb-messages')?.textContent || '')`, 'the message is shown at once', 10000);
        const row = await ev(`(() => { const r = [...document.querySelectorAll('#mb-messages .mb-message')].find(x => /please read this later/.test(x.textContent)); return r ? { queued: r.querySelector('.mb-queued')?.textContent || '', time: r.querySelector('time')?.textContent || '' } : null; })()`);
        assert.equal(row.queued, 'Queued: delivered on resume', JSON.stringify(row));
        assert.match(row.time, /\d{1,2}:\d{2}/, 'with the time it was sent');
        console.log('   ✓');

        console.log('3b. The dock\'s Board chat marks it Queued too (#15378), and the mark goes on resume');
        await ev(`import((window.__coralStatic || '/static/') + 'render.js').then(m => { m.showBoardChatTab(${JSON.stringify(B)}); return true; })`);
        await waitFor(`/please read this later/.test(document.getElementById('board-panel-msgs')?.textContent || '')`, 'the dock chat shows the message', 15000);
        await waitFor(`!![...document.querySelectorAll('#board-panel-msgs .mb-message')].find(x => /please read this later/.test(x.textContent) && x.querySelector('.mb-queued'))`, 'the dock row says Queued', 15000);
        console.log('   ✓');

        console.log('4. Resume team from the line: a toast, the header and the mark go');
        await ev(`document.querySelector('#team-pause-bar .team-pause-resume').click(); true`);
        await waitFor(`/^Team resumed/.test([...document.querySelectorAll('.toast')].map(t => t.textContent).join(' ').trim())`, 'the resume toast', 10000);
        assert.equal((await api('GET', `/api/board/${B}/paused`)).body.paused, false);
        await waitFor(`document.getElementById('team-pause-bar').hidden`, 'the header and the line are back to normal', 10000);
        await waitFor(`![...document.querySelectorAll('#mb-messages .mb-queued')].length`, 'the mark is gone', 10000);
        await waitFor(`![...document.querySelectorAll('#board-panel-msgs .mb-queued')].length`, 'the dock mark is gone too', 10000);
        assert.equal(await menuItem(), 'Pause team');
        assert.match(await ev(`document.getElementById('mb-messages').textContent`), /please read this later/, 'the message is still there');
        console.log('   ✓');
        console.log('PASS team pause: a first click from any tab, Paused in the header with its line, Queued rows at once, Resume team');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
