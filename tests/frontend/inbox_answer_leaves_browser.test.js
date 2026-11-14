// #14408 (follow-up of #14373): an answered row leaves as soon as the agent stops waiting, although a pointer RESTS on the table and another row stays (a hold would keep it up to 10 s). The Answer records the table it began in; that table redraws once, unheld, when the row is gone. 1280 px.
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false]]) { // a resting pointer is a desktop thing
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: a && a.session_id === 'qb-id' ? true : window.__waiting, waiting_kind: a && a.session_id !== 'qb-id' && !window.__waiting ? '' : 'permission', waiting_summary: a && a.session_id !== 'qb-id' && !window.__waiting ? '' : 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('qb', 'B', 5, { sleeping: false, board_project: 'team-a', session_id: 'qb-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${w}: the two agents`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, `${w}: two waiting`, 8000);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); // as the real entries do (app_actions, phone_drawer, goal_view, saved): the Inbox tab is shown first, which mounts its hooks (#14447)
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: both rows' two choices`, 12000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the buttons are armed (the table has settled) before a press
            const rowAt = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr:not(.dt-group)').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`);
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: rowAt.x, y: rowAt.y }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the pointer events reach the page
            const rowOf = name => `[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(tr => tr.textContent.includes('${name}'))`; // the rows of the agents named qa and qb (neither name is part of the other)
            await ev(`${rowOf('qa')}.querySelector('.inbox-answer[data-n="1"]').click(); true`);
            await waitFor(`window.__answers.length === 1 && window.__answers[0].session_id === 'qa-id'`, `${w}: qa's answer is sent`, 8000);
            const stoppedAt = Date.now();
            await ev(`window.__waiting = false; window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`!${rowOf('qa')}`, `${w}: qa's row leaves`, 12000).catch(async e => { throw new Error(e.message + ' | rows: ' + await ev(`JSON.stringify([...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(t => t.textContent.replace(/\\s+/g, ' ').slice(0, 60)))`) + ' badge: ' + await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`)); });
            const took = Date.now() - stoppedAt;
            assert.ok(took < 3500, `${w}: the answered row left as soon as the agent stopped waiting, under a resting pointer (took ${took} ms; a hold is up to 10 s)`);
            assert.ok(await ev(`!!${rowOf('qb')}`), `${w}: the other waiting agent's row stays`);
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 });
            console.log('inbox_answer_leaves_browser: ok');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
