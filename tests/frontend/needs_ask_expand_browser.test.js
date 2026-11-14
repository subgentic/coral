// #14617: a question longer than the preview (500 characters) is opened IN PLACE in its Needs you row: a Show all button after it (only on a long one), 44 px at 390, aria-expanded; opened, the row says every word the Operator's list carries and nothing is cut; Show less closes it. Real clicks and taps, 1280 and 390 px; the Operator's questions are the stubbed /api/operator-asks route (as needs_long_question).
// The rows' answer buttons stay inside their own row and no row overlaps the next, opened or shut.
// (derived from) Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

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
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 54, asker: 'Tester', text: '@Operator ' + ${JSON.stringify(PLAN.repeat(2))}, at: at(8) },
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 53, asker: 'Dev', text: '@Operator May I delete the old books table and start again?', at: at(9) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '6'`, `${w}: waiting badge`, 8000);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: the rows' four choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 6`, `${w}: six rows (two agents, four questions)`, 8000);

            const askRow = who => `[...document.querySelectorAll('#group-table-view tbody tr')].find(tr => tr.querySelector('.inbox-ask-name') && tr.textContent.includes(${JSON.stringify(who)}) && tr.querySelector('.inbox-review-from') && tr.querySelector('.inbox-review-from').textContent.trim() === ${JSON.stringify(who)})`;
            const state = who => ev(`(() => { const tr = ${askRow(who)}; if (!tr) return null; const q = tr.querySelector('.inbox-ask-name'), b = tr.querySelector('.inbox-ask-expand'), r = b && b.getBoundingClientRect(), row = tr.getBoundingClientRect(), next = tr.nextElementSibling && tr.nextElementSibling.getBoundingClientRect(); return { text: q.textContent, len: q.textContent.length, button: b ? { label: b.textContent, expanded: b.getAttribute('aria-expanded'), name: b.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width), inside: r.left >= row.left - 1 && r.right <= row.right + 1 && r.top >= row.top - 1 && r.bottom <= row.bottom + 1, x: r.left + r.width / 2, y: r.top + r.height / 2 } : null, overlapsNext: !!next && row.bottom > next.top + 1, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            const tap = async p => { if (mobile) await touchTap(client, { x: p.x, y: p.y }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); } };
            await ev(`${askRow('Designer')}.scrollIntoView({ block: 'center', behavior: 'instant' }); true`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the row settles after the scroll
            const shut = await state('Designer');
            assert.ok(shut && shut.button, `${w}: the long question has a Show all button: ` + JSON.stringify(shut));
            assert.ok(shut.text.endsWith('…') && shut.len <= 502, `${w}: shut, the question is the preview with its cut shown: ` + shut.len);
            assert.ok(shut.button.label === 'Show all' && shut.button.expanded === 'false' && shut.button.h >= (mobile ? 44 : 28) && shut.button.inside, `${w}: Show all is a control (44 px on a phone) inside the row, unexpanded: ` + JSON.stringify(shut.button));
            for (const short of ['Dev']) assert.equal((await state(short)).button, null, `${w}: a short question has no Show all`);
            await shot(`ask-expand-shut-${w}`);
            await tap(shut.button);
            await waitFor(`(() => { const tr = ${askRow('Designer')}; const b = tr && tr.querySelector('.inbox-ask-expand'); return !!b && b.getAttribute('aria-expanded') === 'true'; })()`, `${w}: one tap opens the question in place`, 6000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the row is drawn again
            const open = await state('Designer');
            assert.ok(open.len === PLAN.repeat(2).replace(/\s+/g, ' ').trim().length + '@Operator '.length && open.text.endsWith('after a reload.') && !open.text.endsWith('…'), `${w}: opened, every word is there and nothing is cut: ${shut.len} -> ${open.len}, ends ${JSON.stringify(open.text.slice(-24))}`);
            assert.ok(open.button.label === 'Show less' && open.button.expanded === 'true' && open.button.h >= (mobile ? 44 : 28) && open.button.inside, `${w}: the button says Show less and stays a control (44 px on a phone) in the row: ` + JSON.stringify(open.button));
            assert.ok(!open.overlapsNext && open.scroll <= 0, `${w}: the opened row does not run over the next one and the page does not scroll sideways: ` + JSON.stringify({ o: open.overlapsNext, s: open.scroll }));
            await ev(`${askRow('Designer')}.scrollIntoView({ block: 'center', behavior: 'instant' }); true`);
            await shot(`ask-expand-open-${w}`);
            // UI Reviewer's MUST: the KEYBOARD. Enter and Space on a toggle open and shut it, focus stays on THE SAME question's toggle (two long questions here: Designer's and Tester's), and Tab goes on from it
            const focusOn = () => ev(`(() => { const e = document.activeElement; return e && e.classList && e.classList.contains('inbox-ask-expand') ? { key: e.dataset.askKey, asker: (e.closest('tr').querySelector('.inbox-review-from') || {}).textContent, expanded: e.getAttribute('aria-expanded') } : { other: e ? (e.id || e.className || e.tagName) : null }; })()`);
            const key = async (k, code) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32, text: k === 'Enter' ? '\r' : ' ' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32 }); };
            const tabKey = async shift => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); };
            await ev(`${askRow('Designer')}.querySelector('.inbox-ask-expand').focus(); true`);
            let f = await focusOn(); assert.equal(f.asker, 'Designer', `${w}: the keyboard is on Designer's toggle: ` + JSON.stringify(f));
            await key('Enter', 'Enter');
            await waitFor(`(() => { const e = document.activeElement; return !!e && e.classList.contains('inbox-ask-expand') && e.getAttribute('aria-expanded') === 'false'; })()`, `${w}: Enter shuts the open question and the focus is still on a toggle that is shut`, 6000).catch(async e => { throw new Error(e.message + ' | ' + JSON.stringify(await focusOn()) + ' | ' + await ev(`JSON.stringify([...document.querySelectorAll('.inbox-ask-expand')].map(b => [(b.dataset.askKey || '').slice(-12), b.getAttribute('aria-expanded')]))`)); });
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: a late redraw would show here
            f = await focusOn(); assert.ok(f.asker === 'Designer' && f.expanded === 'false', `${w}: after Enter the focus is on DESIGNER's toggle, not another question's: ` + JSON.stringify(f));
            assert.equal((await state('Tester')).button.expanded, 'false', `${w}: Tester's question stayed shut`);
            await tabKey(false);
            f = await focusOn(); assert.ok(!f.asker || f.asker !== 'Designer' || f.key !== undefined, `${w}: Tab goes on from Designer's toggle`);
            const after = await ev(`(() => { const e = document.activeElement, t = ${askRow('Designer')}.querySelector('.inbox-ask-expand'); return { moved: e !== t && e !== document.body, forward: !!(t.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING), name: e ? (e.getAttribute('aria-label') || e.textContent || e.tagName).slice(0, 40) : null }; })()`);
            assert.ok(after.moved && after.forward, `${w}: Tab went forward to the next control, not to the page: ` + JSON.stringify(after));
            await tabKey(true);
            f = await focusOn(); assert.ok(f.asker === 'Designer', `${w}: Shift+Tab comes back to Designer's toggle: ` + JSON.stringify(f));
            await key(' ', 'Space');
            await waitFor(`(() => { const e = document.activeElement; return !!e && e.classList.contains('inbox-ask-expand') && e.getAttribute('aria-expanded') === 'true'; })()`, `${w}: Space opens it again and the focus is still on a toggle that is open`, 6000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: a late redraw would show here
            f = await focusOn(); assert.ok(f.asker === 'Designer' && f.expanded === 'true', `${w}: after Space the focus is on DESIGNER's toggle: ` + JSON.stringify(f));
            // the second long question has its own toggle and keeps the focus too
            await ev(`${askRow('Tester')}.querySelector('.inbox-ask-expand').focus(); true`); await key('Enter', 'Enter');
            await waitFor(`(() => { const e = document.activeElement; return !!e && e.classList.contains('inbox-ask-expand') && e.getAttribute('aria-expanded') === 'true' && e.closest('tr').textContent.includes('Tester'); })()`, `${w}: Enter on Tester's toggle opens Tester's question and keeps the focus on it`, 6000);
            assert.equal((await state('Designer')).button.expanded, 'true', `${w}: Designer's question stayed as it was (open) while Tester's opened`);
            await key('Enter', 'Enter'); await new Promise(r => setTimeout(r, 400)); // sleep-ok: shut Tester again
            // Keyboard focus on Tester may have scrolled Designer's toggle outside the phone viewport.
            await ev(`${askRow('Designer')}.querySelector('.inbox-ask-expand').scrollIntoView({block:'center',behavior:'instant'}); true`);
            await ev(framesJs(2));
            const again = await state('Designer');
            assert.ok(await ev(`document.elementFromPoint(${again.button.x},${again.button.y})?.closest('.inbox-ask-expand')?.dataset.askKey === ${askRow('Designer')}.querySelector('.inbox-ask-expand').dataset.askKey`), `${w}: the final tap hits Designer's toggle`);
            await tap(again.button);
            await waitFor(`(() => { const tr = ${askRow('Designer')}; const b = tr && tr.querySelector('.inbox-ask-expand'); return !!b && b.getAttribute('aria-expanded') === 'false'; })()`, `${w}: a second tap shuts it`, 6000);
            const back = await state('Designer');
            assert.ok(back.text.endsWith('…') && back.len === shut.len, `${w}: shut again, the preview is back: ${back.len}`);
        }
        console.log('needs_ask_expand: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
