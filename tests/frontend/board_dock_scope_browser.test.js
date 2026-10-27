// An agent's dock shows what that agent would read, and its own posts (#8484), with no "For this agent | Whole board" switch (#8930): the list asked of the server's one read rule (for_subscriber), one quiet line saying
// what is shown and how many of the board, a search that searches that list ("No match in what <agent> reads"), an empty state, and no choice kept per browser (an old one is forgotten). The Orchestrator's dock shows the whole board. Real board over the
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
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    const lightShot = async n => { await theme('light'); await new Promise(r => setTimeout(r, 500)); await shot(n + '-light'); await theme('dark'); await new Promise(r => setTimeout(r, 500)); }; // sleep-ok: the theme's colour transition settles
    const post = async (who, content) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content }); assert.equal(r.status, 200, JSON.stringify(r)); };
    const AGENT = { subscriber: 'Backend Dev', orchestrator: false, name: 'Backend Dev' };
    const show = agent => ev(`import(${S} + 'render.js').then(m => { m.showBoardChatTab(${JSON.stringify(B)}, ${JSON.stringify(agent)}); return true; })`);
    const rows = () => ev(`[...document.querySelectorAll('#board-panel-msgs > .mb-message .mb-row-snippet, #board-panel-msgs > .mb-message .mb-message-body')].map(e => e.textContent.trim().slice(0, 40))`);
    const state = () => ev(`(() => { const bar = document.querySelector('#agentic-panel-board > .board-chat-scope'), note = document.getElementById('board-chat-scope-note'); return { bar: !!bar, switches: document.querySelectorAll('#agentic-panel-board .mb-view-btn[data-scope], #agentic-panel-board .board-chat-scope button, #agentic-panel-board .board-scope-link, #agentic-panel-board .mb-search-link').length, note: note && !note.hidden ? note.textContent.replace(/\\u00a0/g, ' ') : '', rows: document.querySelectorAll('#board-panel-msgs > .mb-message').length, empty: (document.querySelector('#board-panel-msgs .board-chat-empty') || {}).textContent || '' }; })()`);
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
        await post('Backend Dev', 'On it: the dock task is mine'); // its own post, untagged: it is in its list
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
            await ev(`localStorage.setItem('coral.board.scope', 'all'); true`); // a choice kept by the removed switch is not followed
            await show(AGENT);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 3`, 'the two messages it reads and its own post', 15000);
            let st = await state();
            assert.equal(st.switches, 0, at + 'no switch, no link to the whole board: ' + JSON.stringify(st));
            assert.equal(await ev(`/For this agent|Whole board/.test(document.getElementById('agentic-panel-board').textContent)`), false, at + 'neither word is on the dock');
            assert.equal(await ev(`localStorage.getItem('coral.board.scope')`), null, at + 'the old choice is forgotten');
            assert.equal(st.note, 'Showing what Backend Dev reads: its mentions, @all, its replies and its own posts. 3 of 6 messages', at + 'the line says what is shown and how many');
            assert.match((await rows()).join('|'), /dock task.*standup.*On it/s);
            await shot(`dock-scope-agent-${w}`);
            await lightShot(`dock-scope-agent-${w}`);

            console.log(`${at}2. A new message that tags it arrives through the poll's after_id`);
            await post('Orchestrator', '@Backend Dev one more for you'); await post('QA Engineer', 'Untagged chatter three');
            await show(AGENT); // the panel is kept and asks only for what came after the newest shown
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 4`, 'the new tagged message, not the untagged one', 15000);
            assert.equal((await state()).note, 'Showing what Backend Dev reads: its mentions, @all, its replies and its own posts. 4 of 8 messages');

            console.log(`${at}3b. The dock's search searches what the agent reads, and says so when nothing in it matches`);
            const searchBox = `document.getElementById('bd-search')`;
            const typeSearch = text => ev(`(() => { const i = ${searchBox}; i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await typeSearch('dock');
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message-match, #board-panel-msgs > .mb-message-current').length === 2`, 'the two messages of its list that say dock', 15000);
            await typeSearch('chatter'); // said only by messages outside its list
            await waitFor(`/No match in what Backend Dev reads/.test((document.querySelector('#agentic-panel-board .board-chat-search .mb-search-status') || {}).textContent || '')`, 'the no-match line', 15000);
            await shot(`dock-scope-nomatch-${w}`);
            await lightShot(`dock-scope-nomatch-${w}`);
            assert.equal((await state()).switches, 0, at + 'the no-match line has no way to the whole board');
            await typeSearch('');

            console.log(`${at}3. The Orchestrator's dock shows the whole board and has no scope row`);
            await show({ subscriber: 'Orchestrator', orchestrator: true, name: 'Orchestrator' });
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length === 8`, 'the whole board for the Orchestrator', 15000);
            st = await state(); assert.equal(st.bar, false, at + 'no scope row'); assert.equal(st.note, '');

            console.log(`${at}4. An agent that has read nothing yet (@all reaches every member, so it is one with no seat on the board): the empty line, and no way to the whole board`);
            await show({ subscriber: 'Newcomer', orchestrator: false, name: 'Newcomer' });
            await waitFor(`/Nothing for Newcomer yet/.test((document.querySelector('#board-panel-msgs .board-chat-empty') || {}).textContent || '')`, 'the empty state', 15000);
            st = await state(); assert.equal(st.empty, 'Nothing for Newcomer yet.'); assert.equal(st.rows, 0); assert.equal(st.switches, 0, at + 'no link to the whole board');
            await shot(`dock-scope-empty-${w}`);
            await lightShot(`dock-scope-empty-${w}`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            console.log('   ✓');
        }
        console.log('PASS dock scope: the list by the server read rule, the line, the empty state, no switch and nothing remembered');
    } finally { await removeBoards(ev, made).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
