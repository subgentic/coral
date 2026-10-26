// An agent's dock shows what that agent would read (#8484): "For this agent | Whole board" under the Board tab's head, the list asked of the server's one read rule (for_subscriber), one quiet line saying
// what is shown and how many of the board, an empty state with the way to the whole board, the choice kept per browser. The Orchestrator's dock has no switch and shows the whole board. Real board over the
// API on the isolated dev server (removed again); the dock is mounted as board_table_dock does. 1280 and 390 px; CORAL_SCREENSHOT_DIR saves the shots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let B = null; const made = [];
    const S = `(window.__coralStatic || '/static/')`;
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const post = async (who, content) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content }); assert.equal(r.status, 200, JSON.stringify(r)); };
    const AGENT = { subscriber: 'Backend Dev', orchestrator: false, name: 'Backend Dev' };
    const show = agent => ev(`import(${S} + 'render.js').then(m => { m.showBoardChatTab(${JSON.stringify(B)}, ${JSON.stringify(agent)}); return true; })`);
    const rows = () => ev(`[...document.querySelectorAll('#board-panel-msgs > .mb-message .mb-row-snippet, #board-panel-msgs > .mb-message .mb-message-body')].map(e => e.textContent.trim().slice(0, 40))`);
    const state = () => ev(`(() => { const bar = document.querySelector('#agentic-panel-board > .board-chat-scope'), note = document.getElementById('board-chat-scope-note'); return { bar: !!bar, pressed: bar ? [...bar.querySelectorAll('.mb-view-btn')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')) : [], note: note && !note.hidden ? note.textContent.replace(/\\u00a0/g, ' ') : '', rows: document.querySelectorAll('#board-panel-msgs > .mb-message').length, empty: (document.querySelector('#board-panel-msgs .board-chat-empty') || {}).textContent || '' }; })()`);
    const mount = async (w, h, mobile, dockPx) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { try { localStorage.removeItem('coral.board.scope'); localStorage.setItem('coral.board.view', 'table'); } catch (e) {}
            const agentView = document.getElementById('live-session-view'); if (agentView) agentView.style.display = '';
            let p = document.getElementById('agentic-panel-board'); if (!p) { p = document.createElement('div'); p.id = 'agentic-panel-board'; document.body.appendChild(p); }
            document.body.appendChild(p); p.classList.add('active'); p.hidden = false; p.style.cssText = 'display:flex;flex-direction:column;position:fixed;top:0;right:0;bottom:0;width:${dockPx}px;z-index:50;background:var(--bg-primary)'; return true; })()`);
    };
    const seed = async tag => {
        B = `scope-${tag}-` + Date.now().toString(36); made.push(B);
        for (const [id, t] of [['Orchestrator', 'Orchestrator'], ['Backend Dev', 'Backend Dev'], ['QA Engineer', 'QA Engineer'], ['Frontend Dev', 'Frontend Dev']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-' + B })).status, 200);
        await post('QA Engineer', 'Untagged chatter one');
        await post('Orchestrator', '@Backend Dev please take the dock task');
        await post('Orchestrator', '@all standup at five');
        await post('QA Engineer', 'Untagged chatter two');
        await post('Orchestrator', '@QA Engineer only you');
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [w, h, mobile, dock] of [[1280, 800, false, 420], [390, 844, true, 390]]) {
            const at = `at ${w}px: `;
            await mount(w, h, mobile, dock);
            await seed(w);
            console.log(`${at}1. An agent's dock starts on what that agent reads`);
            await show(AGENT);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 2`, 'the two messages it reads', 15000);
            let st = await state();
            assert.deepEqual(st.pressed, ['For this agent:true', 'Whole board:false'], at + JSON.stringify(st));
            assert.equal(st.note, 'Showing what Backend Dev reads: its mentions, @all and its replies. 2 of 5 messages', at + 'the line says what is shown and how many');
            assert.match((await rows()).join('|'), /dock task.*standup/s);
            await shot(`dock-scope-agent-${w}`);

            console.log(`${at}2. Whole board shows everything, says nothing more, and is remembered`);
            await ev(`document.querySelector('.board-chat-scope .mb-view-btn[data-scope="all"]').click(); true`);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 5`, 'the whole board', 15000);
            st = await state();
            assert.deepEqual(st.pressed, ['For this agent:false', 'Whole board:true']); assert.equal(st.note, '', at + 'no line while the whole board is shown');
            assert.equal(await ev(`localStorage.getItem('coral.board.scope')`), 'all');
            await shot(`dock-scope-all-${w}`);
            await show(AGENT);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 5`, 'the choice kept', 8000);

            console.log(`${at}3. Back to the agent; a new message that tags it arrives through the poll's after_id`);
            await ev(`document.querySelector('.board-chat-scope .mb-view-btn[data-scope="agent"]').click(); true`);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 2`, 'filtered again', 15000);
            await post('Orchestrator', '@Backend Dev one more for you'); await post('QA Engineer', 'Untagged chatter three');
            await show(AGENT); // the panel is kept and asks only for what came after the newest shown
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 3`, 'the new tagged message, not the untagged one', 15000);
            assert.equal((await state()).note, 'Showing what Backend Dev reads: its mentions, @all and its replies. 3 of 7 messages');

            console.log(`${at}4. The Orchestrator's dock shows the whole board and has no switch`);
            await show({ subscriber: 'Orchestrator', orchestrator: true, name: 'Orchestrator' });
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 7`, 'the whole board for the Orchestrator', 15000);
            st = await state(); assert.equal(st.bar, false, at + 'no switch'); assert.equal(st.note, '');

            console.log(`${at}5. An agent that has read nothing yet (@all reaches every member, so it is one with no seat on the board): the empty line and the way to the whole board`);
            await ev(`localStorage.removeItem('coral.board.scope'); true`);
            await show({ subscriber: 'Newcomer', orchestrator: false, name: 'Newcomer' });
            await waitFor(`/Nothing for Newcomer yet/.test((document.querySelector('#board-panel-msgs .board-chat-empty') || {}).textContent || '')`, 'the empty state', 15000);
            st = await state(); assert.equal(st.empty, 'Nothing for Newcomer yet. Show the whole board'); assert.equal(st.rows, 0);
            await shot(`dock-scope-empty-${w}`);
            await ev(`document.querySelector('#board-panel-msgs .board-scope-link').click(); true`);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 7`, 'the link shows the whole board', 15000);
            assert.deepEqual((await state()).pressed, ['For this agent:false', 'Whole board:true']);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            console.log('   ✓');
        }
        console.log('PASS dock scope: For this agent by the server read rule, Whole board, the line, the empty state, remembered');
    } finally { await removeBoards(ev, made).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
