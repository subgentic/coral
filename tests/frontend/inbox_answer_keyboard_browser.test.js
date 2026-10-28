// The Inbox's Needs you rows with answer buttons by keyboard and screen reader (#10560, on #10400): each button's name says the choice and the agent ("Answer Red for qa"), Tab goes through a row's choices
// then its Open and on to the next row, Enter answers, what came of it is said once in the page's live region ("Answered: Red"; "That question changed" when it did), and the keyboard is on something when the
// row leaves or redraws (the next row's first control, never the page). 1280 px; the agents are mocked, the chat reply and the answer are stubbed (inbox_answer_browser's setup, two agents).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a key's answer and the redraw after it
    const key = async (k, code, text) => { const base = { key: k, code: k === 'Tab' ? 'Tab' : k, windowsVirtualKeyCode: code }; await Input.dispatchKeyEvent({ type: 'keyDown', ...base, ...(text ? { text } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...base }); await sleep(60); }; // sleep-ok: the answer, the announcement and the redraw come a moment after the key
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: window.__ask || 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__done = []; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: !window.__done.includes(a.session_id), waiting_kind: 'permission', waiting_summary: 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'dev-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, `${w}: waiting badge`, 8000);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: the row's two choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            // (1) names: the choice and the agent
            const names = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => [...r.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()))`);
            const want = [['Open qa', 'Answer Red for qa', 'Answer Blue for qa'], ['Open dev', 'Answer Red for dev', 'Answer Blue for dev']];
            if (JSON.stringify(names) !== JSON.stringify(want)) problems.push(`${w}: each button's name says the agent and the choice, in reading order: ${JSON.stringify(names)}`);
            // (2) Tab order: from the first choice through the row and on to the next row's
            await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').focus(); true`);
            const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : (a.getAttribute('aria-label') || a.textContent.trim()).slice(0, 40); })()`);
            const order = [await where()];
            for (let i = 0; i < 5; i++) { await key('Tab', 9); order.push(await where()); }
            if (JSON.stringify(order.map(x => x.replace(/ for .*/, ''))) !== JSON.stringify(['Open qa', 'Answer Red', 'Answer Blue', 'Open dev', 'Answer Red', 'Answer Blue'])) problems.push(`${w}: Tab goes Open, choice, choice, then the next row: ${JSON.stringify(order)}`);
            // (3) Enter answers qa's Red: said once, and the keyboard stays in the row
            await ev(`window.__said = []; window.__last = {}; new MutationObserver(() => { for (const id of ['notice-live', 'notice-alert']) { const t = (document.getElementById(id) || {}).textContent; if (t && window.__last[id] !== t) { window.__last[id] = t; window.__said.push(t); } } }).observe(document.body, { childList: true, characterData: true, subtree: true }); document.querySelector('#group-table-view .inbox-answer').focus(); true`);
            await key('Enter', 13, '\r'); await waitFor(`window.__answers.length >= 1`, `${w}: the answer is sent`, 5000); await sleep(1500); // sleep-ok: the answer, the announcement and the redraw come a moment after the key
            const said = await ev(`window.__said.filter(t => /Answered/.test(t))`);
            if (said.length !== 1 || !/Answered: Red for qa/.test(said[0])) problems.push(`${w}: the result is said once in the page's live region (said ${JSON.stringify(said)})`);
            const afterAnswer = await where();
            if (!/^Open qa$/.test(afterAnswer)) problems.push(`${w}: after answering, the keyboard is on the row's Open (it is on ${afterAnswer})`);
            // (4) the agent stops waiting: the row leaves, the keyboard goes to the next row's first control
            await ev(`window.__done = ['qa-id']; window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, `${w}: the row leaves`, 8000); await sleep(800); // sleep-ok: the answer, the announcement and the redraw come a moment after the key
            const afterLeave = await where();
            if (!/^Open dev$/.test(afterLeave)) problems.push(`${w}: when the row leaves, the keyboard goes to the next row's first control (it is on ${afterLeave})`);
            // (5) a question that changed: said, and the keyboard is on a choice of the redrawn row
            await ev(`window.__ask = 'ask-2'; document.querySelector('#group-table-view .inbox-answer:last-of-type, #group-table-view .inbox-answer').focus(); true`);
            await ev(`window.__said.length = 0; true`);
            await key('Enter', 13, '\r'); await sleep(1500); // sleep-ok: the answer, the announcement and the redraw come a moment after the key
            const changed = await ev(`window.__said.filter(t => /changed/.test(t))`);
            if (changed.length !== 1) problems.push(`${w}: "That question changed" is said once (said ${JSON.stringify(changed)})`);
            const afterChanged = await where();
            if (!/^Answer /.test(afterChanged)) problems.push(`${w}: after a changed question the keyboard is on a choice of the redrawn row (it is on ${afterChanged})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Inbox answer buttons by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS the Inbox answer buttons: named, in order, said once, the keyboard kept');
})().catch(e => { console.error(e); process.exitCode = 1; });
