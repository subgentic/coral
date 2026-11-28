// #22094: board questions are complete in place, replacing preview/Show all/less.
// Replacement checks: full separate bodies, numbered lines, safe width/no overlap and real Enter/Space group folding with focus retained. Agent asynchronous expansion remains in needs_agent_ask_expand.
// #14617: a question longer than the preview (500 characters) is opened IN PLACE in its Needs you row: a Show all button after it (only on a long one), 44 px at 390, aria-expanded; opened, the row says every word the Operator's list carries and nothing is cut; Show less closes it. Real clicks and taps, 1280 and 390 px; the Operator's questions are the stubbed /api/operator-asks route (as needs_long_question).
// The rows' answer buttons stay inside their own row and no row overlaps the next, opened or shut.
// (derived from) Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { quietLaunchNotice, restoreLaunchNotice } = require('./helpers/launch_notice');
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
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await quietLaunchNotice(Page, ev, BASE + '/'); /* the unseen first-run notice sits in the phone Inbox pane now (#16460) and shifts what these measure: acked on the test server */ await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false; /* Getting started items count like any row now (#18764), so this suite, which counts questions, switches them off */ window.T && (window.T.state.settings = { ...window.T.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' });
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
                /* exact duplicate questions are one row now (ef1b310926), so the second long question differs in its last words */ { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 52, asker: 'Designer', text: '@Operator ' + ${JSON.stringify(PLAN.repeat(2))}, at: at(6) },
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 54, asker: 'Tester', text: '@Operator ' + ${JSON.stringify(PLAN.repeat(2) + ' (a different question from the Designer\'s, in the same words at the start)')}, at: at(8) },
                { board: 'reading', board_label: 'Reading List', kind: 'ask', id: 53, asker: 'Dev', text: '@Operator May I delete the old books table and start again?', at: at(9) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            try { await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '6'`, `${w}: waiting badge`, 8000); } catch (e) { throw new Error(e.message + ' (badge ' + await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`) + ', rows ' + await ev(`[...document.querySelectorAll('#group-table-view .nl-row')].map(r => r.textContent.trim().slice(0, 40)).join(' | ')`) + ')'); }
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: the rows' four choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row').length === 6`, `${w}: six rows (two agents, four questions)`, 8000);

            // Board questions now show their complete body immediately. There is no
            // Show all/less control to hide words; keyboard folding belongs to the group.
            const askRow = who => `[...document.querySelectorAll('#group-table-view .nl-question')].find(row => row.querySelector('.nl-meta > .agent-link, .nl-meta > .agent-name')?.textContent.trim() === ${JSON.stringify(who)})`;
            const words = who => ev(`(() => { const row = ${askRow(who)}; return (row.querySelector('.nl-question-box') || row.querySelector('.nl-title')).textContent; })()`);
            const designer = await words('Designer'), tester = await words('Tester');
            assert.equal(designer.replace(/\s+/g,' ').trim(), PLAN.repeat(2).replace(/\s+/g,' ').trim(), w + ': every word is already available in the long question');
            assert.ok(designer.endsWith('after a reload.') && !designer.endsWith('…') && !/@Operator/.test(designer), w + ': complete body has no cut marker or repeated address');
            assert.ok(/\n1\) Scope/.test(designer) && /\n2\) Stack/.test(designer) && /\n3\) Screens/.test(designer), w + ': numbered steps retain separate lines');
            assert.ok(tester.includes('a different question from the Designer'), w + ': the second long question remains independently complete');
            assert.equal(await ev(`${askRow('Dev')}.querySelector('.inbox-ask-expand')`), null, w + ': short board questions need no expansion control');
            const cap = await ev(`(() => { const row = ${askRow('Designer')}, q = row.querySelector('.nl-question-box'), p = document.createElement('span'); p.style.cssText = 'position:absolute;visibility:hidden;width:90ch;font:' + getComputedStyle(q).font; q.append(p); const ninety = p.getBoundingClientRect().width; p.remove(); const r = row.getBoundingClientRect(), next = row.nextElementSibling?.getBoundingClientRect(); return { width:q.getBoundingClientRect().width,ninety,overlap:!!next&&r.bottom>next.top+1,overflow:document.documentElement.scrollWidth>innerWidth+1 }; })()`);
            assert.ok(cap.width <= cap.ninety + 1 && !cap.overlap && !cap.overflow, w + ': full body stays readable and does not overlap the next row: ' + JSON.stringify(cap));
            const key = async (name,code,num) => { await client.Input.dispatchKeyEvent({type:'keyDown',key:name,code,windowsVirtualKeyCode:num,text:name==='Enter'?'\r':' '}); await client.Input.dispatchKeyEvent({type:'keyUp',key:name,code,windowsVirtualKeyCode:num}); };
            await ev(`document.querySelector('.nl-group-toggle').focus(); true`);
            await key('Enter','Enter',13);
            assert.equal(await ev(`document.activeElement.getAttribute('aria-expanded')`),'false',w + ': Enter folds the group while focus stays on its toggle');
            await key(' ','Space',32);
            assert.equal(await ev(`document.activeElement.getAttribute('aria-expanded')`),'true',w + ': Space reopens it without moving focus');
            assert.equal(await words('Designer'),designer,w + ': folding never changes the full question');
            assert.equal(await words('Tester'),tester,w + ': the other question stays complete');
            await shot(`ask-complete-${w}`);
        }
        console.log('needs_ask_expand: ok');
    } finally { try { await restoreLaunchNotice(ev); } catch (e) {} await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
