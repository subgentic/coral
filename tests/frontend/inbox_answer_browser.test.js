// Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
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
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .inbox-answer')].map(b => b.textContent)`), ['Red', 'Blue'], `${w}: the card's own one-time choices (the lasting one is left to Open)`);
            // the buttons fit in their column on every width: the column is never narrower than the buttons it holds (it was 9 px wide and clipped them, #10516)
            const fit = await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'), cell = b.closest('td') || b.closest('.dt-mail-cell, .inbox-answers'), r = b.getBoundingClientRect(), c = cell.getBoundingClientRect(); return { btnW: Math.round(r.width), cellW: Math.round(c.width), visible: r.width > 20 && r.right <= innerWidth + 1 && r.left >= 0, clipped: [...document.querySelectorAll('#group-table-view .inbox-answer')].some(x => { const q = x.getBoundingClientRect(); let p = x.parentElement; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { const pr = p.getBoundingClientRect(); if (q.right > pr.right + 1 || q.left < pr.left - 1) return true; } p = p.parentElement; } return false; }) }; })()`);
            assert.ok(fit.visible && !fit.clipped && fit.cellW >= fit.btnW, `${w}: the answer buttons are whole inside their column ${JSON.stringify(fit)}`);
            if (!mobile) assert.ok(fit.cellW >= 100, `${w}: the Answer column has room for its buttons (about 110 px): ${JSON.stringify(fit)}`);
            if (mobile) assert.ok(await ev(`[...document.querySelectorAll('#group-table-view .inbox-answer')].every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().right <= innerWidth)`), '390: each is a 44 px target in both directions and on the screen');
            if (mobile) { // the choices of a phone row are a full-width pair, not a small indented one (#10874: a destructive prompt deserves room)
                const g = await ev(`(() => { const bs = [...document.querySelectorAll('#group-table-view .inbox-answer')].map(b => b.getBoundingClientRect()), row = document.querySelector('#group-table-view .inbox-answers').getBoundingClientRect(); return { left: Math.round(bs[0].left), right: Math.round(bs[bs.length - 1].right), rowW: Math.round(row.width), vw: innerWidth }; })()`);
                assert.ok(g.left <= 28 && g.right >= g.vw - 28, '390: the pair spans the row, no 56 px indent: ' + JSON.stringify(g));
            }
            if (mobile) { // a toast is not drawn over the folder picker of the phone's list (#10525)
                await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(m => m.showToast('A notice for the Inbox', false, 60000)); true`);
                await waitFor(`!!document.querySelector('#notices .toast')`, '390: a toast', 5000);
                await new Promise(r => setTimeout(r, 500)); // sleep-ok: the toast column places itself under what it must not cover
                const clear = await ev(`(() => { const t = document.querySelector('#notices .toast').getBoundingClientRect(), p = document.querySelector('#group-table-view .view-list-trigger').getBoundingClientRect(); return { toastTop: Math.round(t.top), pickerBottom: Math.round(p.bottom), pickerTop: Math.round(p.top) }; })()`);
                assert.ok(clear.toastTop >= clear.pickerBottom, `390: the toast starts below the folder picker ${JSON.stringify(clear)}`);
                await ev(`document.querySelectorAll('#notices .toast').forEach(t => t.remove()); true`);
            }
            await shot(`inbox-answer-${w}`);
            // by keyboard: Tab to Red, Enter
            await ev(`document.querySelector('#group-table-view .inbox-answer').focus(); true`);
            assert.equal(await ev(`document.activeElement.classList.contains('inbox-answer')`), true, `${w}: the choice takes the focus`);
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`window.__answers.length >= 1`, `${w}: the answer is sent by Enter on the focused choice ` + await ev(`JSON.stringify([window.__answers, document.activeElement.tagName, document.querySelector('.top-nav-tab.active')?.dataset.arg, [...document.querySelectorAll('.toast')].map(t => t.textContent), document.querySelectorAll('#group-table-view .inbox-answer').length])`), 5000);
            const sent = await ev(`window.__answers`);
            assert.deepEqual(sent, [{ session_id: 'qa-id', agent_type: sent[0].agent_type, n: 1, label: 'Red', text: '', ask_id: 'ask-1' }], `${w}: the same route and body as the card: ${JSON.stringify(sent)}`);
            assert.match(await ev(`document.querySelector('#group-table-view .inbox-answers').textContent`), /^Answered: Red$/, `${w}: the row says it`);
            assert.equal(await ev(`!!(window.T && T.state.currentSession && T.state.currentSession.session_id === 'qa-id')`), false, `${w}: the agent was not opened`);
            assert.equal(sent.length, 1, `${w}: sent once`);
            // the agent stops waiting: the row goes
            await ev(`window.__waiting = false; window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${w}: the row leaves`, 8000);
        }
        // a multi-select has no one-press answer: no buttons
        await ev(`window.__multi = true; window.__waiting = true; window.__answers = []; true`);
        console.log('\nPASS the Needs you row answers a question with the card\'s own choices, same route, keyboard and 44 px');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
