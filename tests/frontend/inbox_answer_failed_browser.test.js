// A failed answer from the Inbox says what to do and has the button for it (#10399 point 5, the Orchestrator: "Open the agent and use its terminal" with no button): when the answer cannot be sent the toast
// says so in plain words and has Open agent, which opens that agent. 1280 px, isolated dev server; the agents are mocked, the chat reply is stubbed and the answer is refused (HTTP 500).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, `${w}: waiting badge`, 8000);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 2`, `${w}: the row's two choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            await ev(`document.querySelector('#group-table-view .inbox-answer').click(); true`);
            await waitFor(`window.__answers.length === 1 && [...document.querySelectorAll('.toast')].some(t => /Could not send the answer/.test(t.textContent))`, `${w}: the failure toast`, 8000);
            const toast = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Could not send the answer/.test(x.textContent)); return { text: t.querySelector('span') ? t.querySelector('span').textContent : t.textContent, buttons: [...t.querySelectorAll('button')].map(b => b.textContent.trim()) }; })()`);
            assert.doesNotMatch(toast.text, /terminal/i, `${w}: no terminal in the words: ` + JSON.stringify(toast));
            assert.ok(toast.buttons.includes('Open agent'), `${w}: and the button for it: ` + JSON.stringify(toast));
            await ev(`[...document.querySelectorAll('.toast button')].find(b => /^Open agent$/.test(b.textContent.trim())).click(); true`);
            await waitFor(`!!(window.T && T.state.currentSession && T.state.currentSession.session_id === 'qa-id')`, `${w}: Open agent opens that agent`, 8000);
        }
        console.log('PASS a failed Inbox answer has Open agent');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
