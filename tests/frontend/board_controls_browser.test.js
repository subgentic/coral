// The board's own controls, pinned as they were before message_board.js was split (#8399): Pause Board / Resume Board (the button's words and the server's paused flag), Sleep (Wake Team, the
// composer disabled with its words; the sleeping banner is not asserted: messages drawn over the board's list remove it, which is how it behaved before the split), and a message's delete (asks first, names the sender and the start of the text; deleting removes the row).
// A real board on the isolated dev server (removed again); the sleep state is answered by a stand-in (no agents here to sleep).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { openBoardPage } = require('./helpers/team_board');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'bc-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status, 200);
        const first = await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'orch', content: 'First thing   to say, with some length so it is cut in the confirmation text, past sixty characters in all.' });
        assert.ok(first.status < 300, JSON.stringify(first)); const ID = first.body.id;
        assert.ok((await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'orch', content: 'Second' })).status < 300);
        await ev(`localStorage.setItem('coral.board.view', 'chat'); true`);
        await openBoardPage(ev, waitFor, B);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 2`, 'the two messages', 15000);

        console.log('1. Pause Board and Resume Board');
        assert.equal(await ev(`document.getElementById('mb-pause-btn').textContent`), 'Pause Board');
        await ev(`import(${S} + 'message_board.js').then(m => m.toggleBoardPause()).then(() => true)`);
        await waitFor(`document.getElementById('mb-pause-btn').textContent === 'Resume Board'`, 'the button says Resume Board', 8000);
        assert.equal(await ev(`document.getElementById('mb-pause-btn').classList.contains('mb-action-danger')`), true, 'a paused board marks its button');
        assert.equal((await api('GET', `/api/board/${B}/paused`)).body.paused, true, 'the server holds the board paused');
        await ev(`import(${S} + 'message_board.js').then(m => m.toggleBoardPause()).then(() => true)`);
        await waitFor(`document.getElementById('mb-pause-btn').textContent === 'Pause Board'`, 'the button says Pause Board again', 8000);
        assert.equal(await ev(`document.getElementById('mb-pause-btn').classList.contains('mb-action-danger')`), false);
        assert.equal((await api('GET', `/api/board/${B}/paused`)).body.paused, false);
        console.log('   ✓');

        console.log('2. A sleeping team');
        // the page asks the server for the sleep state each time the board is shown (showBoardInPage): the stand-in answers that one request
        const sleep = on => ev(`(async () => { const real = window.fetch; window.fetch = (u, o) => /\\/sleep-status$/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ sleeping: ${on} }), { headers: { 'content-type': 'application/json' } })) : real(u, o); try { const m = await import(${S} + 'message_board.js'); m.showBoardInPage(${JSON.stringify(B)}, document.getElementById('team-panel-messages')); await new Promise(r => setTimeout(r, 600)); } finally { window.fetch = real; } return true; })()`); // sleep-ok: the page's own request settles
        await sleep(true);
        const asleep = await ev(`({ btn: document.getElementById('mb-sleep-btn')?.textContent ?? null, input: document.getElementById('mb-post-input').disabled, placeholder: document.getElementById('mb-post-input').placeholder, send: document.querySelector('#mb-board .btn-primary').disabled, opacity: document.querySelector('#mb-board .btn-primary').style.opacity })`);
        assert.deepEqual(asleep, { btn: asleep.btn, input: true, placeholder: 'Team is sleeping...', send: true, opacity: '0.4' });
        await sleep(false);
        const awake = await ev(`({ input: document.getElementById('mb-post-input').disabled, placeholder: document.getElementById('mb-post-input').placeholder, send: document.querySelector('#mb-board .btn-primary').disabled, opacity: document.querySelector('#mb-board .btn-primary').style.opacity })`);
        assert.deepEqual(awake, { input: false, placeholder: 'Message the team...', send: false, opacity: '' });
        console.log('   ✓');

        console.log('3. Deleting a message asks first, then removes it');
        await ev(`window.__confirm = null; window.showConfirmModal = (title, text, ok) => { window.__confirm = { title, text, ok }; }; true`);
        await ev(`(() => { const b = document.createElement('button'); b.setAttribute('data-on-click', 'mb-msg-delete'); b.dataset.msgId = ${JSON.stringify(String(ID))}; document.body.append(b); b.click(); b.remove(); return true; })()`);
        const asked = await ev(`({ title: window.__confirm.title, text: window.__confirm.text })`);
        assert.equal(asked.title, 'Delete Message');
        assert.equal(asked.text, 'Delete the message from Orchestrator ("First thing to say, with some length so it is cut in the con…")? This cannot be undone.');
        assert.equal(await ev(`document.querySelectorAll('#mb-messages .mb-message').length`), 2, 'asking deletes nothing');
        await ev(`window.__confirm.ok(); true`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length === 1`, 'the row is gone', 8000);
        assert.equal((await api('GET', `/api/board/${B}/messages/all`)).body.length ?? (await api('GET', `/api/board/${B}/messages/all`)).body.messages?.length, 1, 'the server has one message left');
        console.log('   ✓');

        console.log('PASS board controls: pause, sleep, delete and their words');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
