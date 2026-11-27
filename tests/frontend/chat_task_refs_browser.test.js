// #21818: "#1234" in an agent's chat is a link to that task on the agent's team, and "goal #257" a link to that goal. Code, words, URLs and short numbers stay text; the links are
// keyboard focusable (Enter opens), and a press opens the Inbox task or goal page. At 1280 and 390. Isolated dev server; invented names and numbers.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, settle } = require('./helpers/wait');
const sceneShots = require('./helpers/scene_shots');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = sceneShots(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const HTML = `<div class="message-text"><p>Task #19739 is in review, see also goal #257 and #21221.</p><p>Not links: <code>#21221</code> in code, abc#123 in a word, https://example.test/page#456, the 2 digit #12, and #1234567890123.</p></div>`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            const scene = async () => {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; const { makeBubble } = await import(${S} + 'chat_bubbles.js');
                    st.currentSession = { type: 'live', name: 'app-agent', session_id: 's1', display_name: 'Lead Dev', board_project: 'demo-team', server: 'local' };
                    const c = document.createElement('div'); c.className = 'chat-prose chat-messages'; c.style.display = 'block'; c.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;padding:24px;background:var(--bg-primary,#fff)'; document.body.append(c);
                    const b = makeBubble('chat-bubble assistant', ${JSON.stringify(HTML)}); b.id = 'ref-bubble'; c.append(b); return true; })()`);
                await waitFor(`document.querySelectorAll('#ref-bubble a.chat-task-ref').length === 3`, `${at}the three numbers to become links`);
            };
            await scene();
            const r = await ev(`(() => { const as = [...document.querySelectorAll('#ref-bubble a.chat-task-ref')]; return { links: as.map(a => [a.textContent, a.dataset.kind, a.dataset.id, a.dataset.team]), tab: as.every(a => a.tabIndex === 0 && a.matches('a[href]')), text: document.getElementById('ref-bubble').textContent, codeLinked: !!document.querySelector('#ref-bubble code a, #ref-bubble a code') }; })()`);
            assert.deepEqual(r.links, [['#19739', 'task', '19739', 'demo-team'], ['goal #257', 'goal', '257', 'demo-team'], ['#21221', 'task', '21221', 'demo-team']], `${at}task, goal and a second task link on the agent's team: ${JSON.stringify(r.links)}`);
            assert.ok(r.tab, `${at}every link is a focusable anchor`);
            assert.ok(!r.codeLinked, `${at}a number in code stays text`);
            assert.ok(r.text.includes('abc#123') && r.text.includes('page#456') && r.text.includes('#12,') && r.text.includes('#1234567890123'), `${at}words, URLs, short and huge numbers stay text`);
            await shot('chat-refs-' + w);
            // A press opens the task page.
            await ev(`document.querySelector('#ref-bubble a.chat-task-ref[data-kind=task]').click(); true`);
            await waitFor(`/19739/.test(location.href)`, `${at}a press to go to task 19739`, 8000);
            // Enter on the focused goal link opens the goal page.
            await scene();
            await ev(`document.querySelector('#ref-bubble a.chat-task-ref[data-kind=goal]').focus(); true`);
            for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
            await waitFor(`/257/.test(location.href)`, `${at}Enter on the goal link to go to goal 257`, 8000);
            // The same rule in a board message (one helper), and an unknown number is still a link: no fetch at render, the task page says not found.
            await ev(`(async () => { const { resolveBoardArtifacts } = await import(${S} + 'board_artifacts.js');
                const m = document.createElement('div'); m.className = 'mb-message'; m.innerHTML = '<div class="mb-message-body"><p>Review #20001 for goal #258 and see <code>#20002</code>; #999999 is unknown.</p></div>'; m.id = 'board-msg'; document.getElementById('ref-bubble').parentNode.append(m);
                resolveBoardArtifacts(m, 'local', 'demo-team'); return true; })()`);
            await waitFor(`document.querySelectorAll('#board-msg a.chat-task-ref').length === 3`, `${at}board message numbers to become links`);
            const bl = await ev(`[...document.querySelectorAll('#board-msg a.chat-task-ref')].map(a => [a.textContent, a.dataset.kind, a.dataset.id, a.dataset.team])`);
            assert.deepEqual(bl, [['#20001', 'task', '20001', 'demo-team'], ['goal #258', 'goal', '258', 'demo-team'], ['#999999', 'task', '999999', 'demo-team']], `${at}board message links, unknown number included: ${JSON.stringify(bl)}`);
            await ev(`document.querySelector('#board-msg a.chat-task-ref[data-id="999999"]').click(); true`);
            await waitFor(`/999999/.test(location.href)`, `${at}an unknown number still opens the task page`, 8000);
        }
    } finally { await client.close(); }
    console.log('PASS task and goal numbers in chat are links on the agent\'s team; code, words, URLs and short numbers stay text; Enter and a press open them');
})().catch(e => { console.error(e); process.exit(1); });
