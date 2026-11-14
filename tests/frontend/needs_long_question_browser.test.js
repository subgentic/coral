// Needs you shows a question in full (#14574, Beta run 3): a long question to the Operator and a waiting agent's long question wrap in their rows (nothing cut to a line or two) so an inbox-only person reads them without opening them, a question longer than the preview (500 characters) ends in an ellipsis,
// and the rows' answer buttons stay inside their own row, no row over the next, at 1280 and 390 px. Derived from inbox_answer_browser (its agent, chat reply and answer stubs); the Operator's questions are the stubbed /api/operator-asks route.
// (derived from) Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PLAN = 'Plan for the Reading List app (task #1) — OK to proceed? 1) Scope: a single-page app that lists books, lets me mark one as read and keeps my notes. 2) Stack: plain HTML, CSS and JavaScript, no build step, data in localStorage. 3) Screens: the list, a book page, an add form. 4) Done when: I can add a book, mark it read and see it after a reload.';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: ${JSON.stringify(PLAN)}, ask_id: 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Yes', action: 'select' }, { n: 2, label: 'No', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Wants to know: ' + ${JSON.stringify(PLAN)} });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('dev', 'B', 5, { sleeping: false, board_project: 'team-a', session_id: 'dev-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await ev(`(() => { const at = n => new Date(Date.now() - n * 60000).toISOString(); window.__asks = [
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 51, asker: 'Orchestrator', text: '@Operator ' + ${JSON.stringify(PLAN)}, at: at(4) },
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 52, asker: 'Designer', text: '@Operator ' + ${JSON.stringify(PLAN.repeat(2))}, at: at(6) },
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 53, asker: 'Dev', text: '@Operator May I delete the old books table and start again?', at: at(9) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '5'`, `${w}: waiting badge`, 8000);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: the rows' four choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === 5`, `${w}: five rows (two agents, three questions)`, 8000);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view tbody'); if (!t) return false; const k = t.innerText.length + ':' + t.getBoundingClientRect().height; if (window.__nlq !== k) { window.__nlq = k; window.__nlqAt = performance.now(); return false; } return performance.now() - window.__nlqAt > 500; })()`, `${w}: the rows have settled`, 8000);
            await shot(`needs-long-question-${w}`);
            await ev(`document.querySelector('#group-table-view tbody tr:last-child').scrollIntoView({ block: 'end', behavior: 'instant' }); true`); await shot(`needs-long-question-agents-${w}`);
            await ev(`document.querySelector('#group-table-view tbody tr:first-child').scrollIntoView({ block: 'start', behavior: 'instant' }); true`);
            const rows = await ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')]; const r = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
                return tr.map((row, i) => { const own = r(row), next = tr[i + 1] && r(tr[i + 1]); const q = row.querySelector('.inbox-ask-name, .inbox-whole-name, .dt-mail-snippet, .dt-subtitle'); const cut = q ? q.scrollHeight > q.clientHeight + 1 || q.scrollWidth > q.clientWidth + 1 || getComputedStyle(q).textOverflow === 'ellipsis' && q.scrollWidth > q.clientWidth : null;
                    const lines = q ? Math.round(q.getBoundingClientRect().height / parseFloat(getComputedStyle(q).lineHeight || 18)) : 0;
                    const btns = [...row.querySelectorAll('.btn')].filter(b => b.getClientRects().length).map(b => r(b)); const outsideEls = [...row.querySelectorAll('.btn')].filter(b => b.getClientRects().length).filter(b => { const x = b.getBoundingClientRect(); if (x.left < -1) return false; /* a phone row's swipe actions wait past the screen's left edge by design */ return x.bottom > own.bottom + 1 || x.top < own.top - 1 || x.right > innerWidth + 1; }); const outside = outsideEls.length; const what = outsideEls.map(b => b.className + '@' + Math.round(b.getBoundingClientRect().left) + ',' + Math.round(b.getBoundingClientRect().top - own.top) + ' in ' + (b.parentElement && b.parentElement.className)); const dbg = q && q.classList.contains('dt-mail-snippet') ? [q.parentElement, q.closest('.dt-mail-text'), q.closest('.dt-mail-open'), q.closest('td')].map(e => e ? e.className.slice(0, 24) + ':' + Math.round(e.getBoundingClientRect().height) + ':' + getComputedStyle(e).overflow + ':' + getComputedStyle(e).display : '-') : ''; const h = q ? Math.round(q.getBoundingClientRect().height) : 0, ws = q ? getComputedStyle(q).whiteSpace : '';
                    return { text: q ? q.textContent : '', cut, lines, h, ws, what, buttons: btns.length, outside, overlapsNext: !!next && own.bottom > next.top + 1 }; }); })()`);
            console.log(`${w}: rows ` + JSON.stringify(rows.map(x => ({ t: x.text.slice(0, 30), end: x.text.slice(-18), cut: x.cut, lines: x.lines, buttons: x.buttons, outside: x.outside, what: x.what, dbg: x.dbg, h: x.h, ws: x.ws, overlapsNext: x.overlapsNext }))));
            assert.ok(rows.filter(x => /Plan for the Reading List/.test(x.text)).length === 4, `${w}: two questions and two agents carry the plan: ` + JSON.stringify(rows.map(x => x.text.slice(0, 40))));
            assert.ok(rows.some(x => /after a reload\.$/.test(x.text) && x.text.startsWith('@Operator Plan for the Reading List app (task #1) \u2014 OK to proceed? 1) Scope:')), `${w}: the question to the Operator is whole, from its first words to "after a reload."`);
            if (mobile) assert.equal(rows.filter(x => /^Wants to know: Plan for the Reading List/.test(x.text) && /after a reload\.$/.test(x.text)).length, 2, `${w}: each waiting agent's question is whole on a phone (a wide row keeps one line a row, its tip has the words)`);
            assert.ok(rows.some(x => x.text.endsWith('\u2026') && x.text.length > 480), `${w}: a question longer than the preview ends in an ellipsis: ` + JSON.stringify(rows.map(x => x.text.slice(-12))));
            assert.ok(rows.every(x => x.cut !== true || (!mobile && /^Wants to know/.test(x.text))), `${w}: no question is cut to a line or two: ` + JSON.stringify(rows.map(x => ({ cut: x.cut, lines: x.lines }))));
            assert.ok(rows.filter(x => x.text.length > 150 && (mobile || !/^Wants to know/.test(x.text))).every(x => x.lines >= 2), `${w}: a long question wraps onto more than one line`);
            assert.ok(rows.every(x => x.outside === 0), `${w}: the answer buttons stay inside their row: ` + JSON.stringify(rows.map(x => x.outside)));
            assert.ok(rows.every(x => !x.overlapsNext), `${w}: no row runs over the next: ` + JSON.stringify(rows.map(x => x.overlapsNext)));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
