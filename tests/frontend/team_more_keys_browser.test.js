// The team page's More menu takes the real keys (#16432, QA2's MUST): with the focus on its button, Down and Up move into the items and wrap, Home and End jump, and Tab closes the menu and goes on
// from the button. Real key events (Input.dispatchKeyEvent) on a real team page, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const BOARD = 'more-keys-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const KEYS = { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Tab: 9 };
    const press = async k => { const o = { key: k, code: k, windowsVirtualKeyCode: KEYS[k] }; await Input.dispatchKeyEvent({ type: 'rawKeyDown', ...o }); await Input.dispatchKeyEvent({ type: 'keyUp', ...o }); await ev(framesJs(3, 2000)); }; // (frames after the key, bounded: its handler has run at any CPU speed, where a fixed 120 ms did not at throttle 8)
    const mk = (id, name) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: BOARD, sleeping: false });
    const problems = [], check = (ok, msg) => { if (!ok) problems.push(msg); };
    const at = () => ev(`(() => { const items = [...document.querySelectorAll('#team-page-more-menu button')].filter(b => !b.hidden && b.getClientRects().length); const a = document.activeElement; return { idx: items.indexOf(a), id: a && a.id, n: items.length, open: !document.getElementById('team-page-more-menu').hidden }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss'), mk('s2', 'Worker')])}; T.render.renderLiveSessions(T.state.liveSessions); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
        await waitFor(`!!document.getElementById('team-page-more')`, 'the More button', 15000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the header fills
        await ev(`document.getElementById('team-page-more').focus(); document.getElementById('team-page-more').click(); true`);
        await waitFor(`!document.getElementById('team-page-more-menu').hidden`, 'the menu opens', 5000);
        let s = await at(); check(s.idx === 0 && s.n >= 4, `open, the focus is on the first shown item (#16432, 6f4a3bba6d): ${JSON.stringify(s)}`);
        const n = s.n;
        await press('ArrowDown'); s = await at(); check(s.idx === 1, `Down from the first item is the second: ${JSON.stringify(s)}`);
        await press('ArrowDown'); s = await at(); check(s.idx === 2, `Down again is the third: ${JSON.stringify(s)}`);
        await press('ArrowUp'); s = await at(); check(s.idx === 1, `Up goes back: ${JSON.stringify(s)}`);
        await press('End'); s = await at(); check(s.idx === n - 1, `End is the last item: ${JSON.stringify(s)}`);
        await press('Home'); s = await at(); check(s.idx === 0, `Home is the first: ${JSON.stringify(s)}`);
        await press('ArrowUp'); s = await at(); check(s.idx === n - 1, `Up from the first wraps to the last: ${JSON.stringify(s)}`);
        await press('Tab'); s = await at(); check(!s.open, `Tab closes the menu: ${JSON.stringify(s)}`);
        // Tab from the button itself (focus never moved into the menu) closes it too
        await ev(`document.getElementById('team-page-more').focus(); if (document.getElementById('team-page-more-menu').hidden) document.getElementById('team-page-more').click(); true`);
        await waitFor(`!document.getElementById('team-page-more-menu').hidden`, 'the menu opens again', 5000);
        await press('Tab'); s = await at(); check(!s.open, `Tab from the button closes the menu: ${JSON.stringify(s)}`);
        // after Stop agents (Kill all) is chosen and its confirmation is cancelled, the menu takes the keys and Tab closes it just the same (#16432 item 2, #17417)
        await ev(`document.getElementById('team-page-more').focus(); if (document.getElementById('team-page-more-menu').hidden) document.getElementById('team-page-more').click(); true`);
        await waitFor(`!document.getElementById('team-page-more-menu').hidden`, 'the menu opens for Stop agents', 5000);
        await ev(`document.querySelector('#team-page-more-menu [data-stop="kill"]').click(); true`);
        await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, 'the Stop agents confirmation', 8000);
        await ev(`document.querySelector('#confirm-modal .modal-footer button:not(#confirm-modal-yes), #confirm-modal [data-on-click="confirm-no"], #confirm-modal .modal-close').click(); true`);
        await waitFor(`document.getElementById('confirm-modal').style.display !== 'flex'`, 'the confirmation is cancelled', 5000);
        await ev(`document.getElementById('team-page-more').focus(); document.getElementById('team-page-more').click(); true`);
        await waitFor(`!document.getElementById('team-page-more-menu').hidden`, 'the menu opens after Stop agents', 5000);
        await press('ArrowDown'); s = await at(); check(s.idx === 1, `after Stop agents, the menu opens on the first item and Down is the second: ${JSON.stringify(s)}`);
        await press('End'); s = await at(); check(s.idx === s.n - 1, `after Stop agents, End is the last item: ${JSON.stringify(s)}`);
        await press('Tab'); s = await at(); check(!s.open, `after Stop agents, Tab closes the menu: ${JSON.stringify(s)}`);
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the More menu keys:\n  ' + problems.join('\n  '));
    console.log('PASS the team More menu: Down, Up, Home, End move from the button and Tab closes it (real keys)');
})().catch(e => { console.error(e.message); process.exit(1); });
