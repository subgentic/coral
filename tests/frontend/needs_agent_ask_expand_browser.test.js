// #14637 (1): a waiting agent's own question ("Wants to know: ...") that the server's 200-character summary cut gets Show all like an Operator question (#14617): the click reads the whole question once from the agent's chat state (through the Hub: /api/remote/m1/...),
// the row says it in place, Show less goes back, opening again does not read again, a short question has no button, and the keyboard (Tab, Enter, Space) does it with focus kept. It holds for the ordinary list of ONLY waiting agents (one-line mail rows) and for a list with an Operator question (item rows).
// A read that gives nothing (refused, or the agent moved on) opens nothing: the row says so and offers Retry, which works once the read does. Through the stubbed Hub world, 1280 and 390 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');

const SINCE = new Date(Date.now() - 120000).toISOString();
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code) => { const enter = k === 'Enter'; await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: enter ? 13 : 32, text: enter ? '\r' : ' ' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: enter ? 13 : 32 }); };
    const tab = async shift => { await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const withAsk of [false, true]) for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px, ${withAsk ? 'with an Operator question' : 'only waiting agents'}: `, rows = withAsk ? 3 : 2;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            const agents = `(() => { const long = 'Wants to know: ' + 'Which of the two storage layouts do we keep for the launch, given the migration cost and the rollback plan? '.slice(0, 184) + '\\u2026'; const agent = (id, name, summary) => ({ session_id: id, name: id, display_name: name, agent_type: 'claude', working_directory: '/repo/' + id, server: 'm1', sleeping: false, archived: false, status: 'idle', waiting_for_input: true, waiting_kind: 'question', waiting_summary: summary, waiting_since: ${JSON.stringify(SINCE)} }); return [agent('long-1', 'Backend Dev', long), agent('short-1', 'Designer', 'Wants to know: Red or blue?')]; })()`;
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })); window.__chatReads = []; window.__reads = 0; window.__chatFail = false;
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/);
                    if (u.pathname === '/api/sessions/live') return json({ sessions: ${agents}.filter(a => !(window.__hideLong && a.session_id === 'long-1')) });
                    if (mm && mm[2] === '/api/operator-asks') return json(${withAsk} && mm[1] === 'm1' ? [{ board: 'team-x', kind: 'ask', id: 7, asker: 'Planner', text: 'Ship tonight or wait?', cut: false, at: new Date(Date.now() - 60000).toISOString() }] : []);
                    if (mm && mm[2] === '/api/needs-you' && /kind=skill/.test(u.search)) return json({ count: 0, counts: { skill: 0 }, items: [] });
                    if (mm && /^\\/api\\/sessions\\/live\\/long-1\\/chat$/.test(mm[2])) { window.__chatReads.push(u.pathname); window.__reads++; (window.__chatLog = window.__chatLog || []).push(window.__chatFail ? 'fail' : 'ok'); if (window.__chatFail) return Promise.resolve(new Response('{}', { status: 500 })); const body = window.__chatEmpty ? { messages: [], total: 0, prompt_options: { question: '', ask_id: 'a1', options: [] } } : { messages: [], total: 0, prompt_options: { question: 'WHOLE-' + window.__reads + ' ' + 'Which storage layout do we keep for the launch, given the migration cost, the rollback plan and the backup window? '.repeat(4) + 'END-MARK', ask_id: 'a1', options: [] } }; return new Promise(res => setTimeout(() => res(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), window.__chatDelay || 0)); }
                    return original(url, opts); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${agents}; m.updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === ${rows}`, `${at}the rows`, 15000);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the rows settle
            const rowText = () => ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => /Backend Dev/i.test(r.innerText)); const d = tr && tr.nextElementSibling && tr.nextElementSibling.classList.contains('dt-detail') ? tr.nextElementSibling.innerText : ''; return tr ? tr.innerText + d : null; })()`); // a wide row's opened question is the detail row under it
            const buttons = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-ask-expand')].map(b => ({ text: b.textContent, expanded: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label') }))`);
            const whole = () => ev(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`);
            const onButton = txt => ev(`(() => { const b = document.activeElement; return !!b && b.classList.contains('inbox-ask-expand') && b.textContent === ${JSON.stringify(txt)}; })()`);
            const before = await buttons(), t0 = await rowText();
            await shot(`needs-agent-ask-${withAsk ? 'mixed' : 'agents'}-${w}-before`);
            check(`${at}one Show all, on the cut question only (the short one has none)`, before.length === 1 && before[0].text === 'Show all' && before[0].expanded === 'false' && /Backend Dev/i.test(before[0].label), JSON.stringify(before));
            check(`${at}the row says the server's cut line, not the whole question yet`, /…/.test(t0) && !/END-MARK/.test(t0), JSON.stringify(t0).slice(0, 240));
            // a read that gives nothing: nothing opens, the row says so, Retry
            await ev(`window.__chatFail = true; true`); const readsBefore = await ev(`window.__reads`);
            await ev(`document.querySelector('#group-table-view .inbox-ask-expand').focus(); true`); await key('Enter', 'Enter');
            await waitFor(`/Could not read the whole question/.test(document.getElementById('group-table-view').innerText)`, `${at}the failure is said`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the redraw and the focus restore settle
            const failed = await buttons();
            check(`${at}a failed read opens nothing, says so, and offers Retry (not expanded)`, failed.length === 1 && failed[0].text === 'Retry' && failed[0].expanded === 'false' && !(await whole()), JSON.stringify(failed));
            check(`${at}the failed read was made once, at the click, and focus is on Retry`, (await ev(`window.__reads`)) === readsBefore + 1 && await onButton('Retry'));
            await shot(`needs-agent-ask-${withAsk ? 'mixed' : 'agents'}-${w}-failed`);
            // an EMPTY success (200, no question in it) is the same: nothing opens, the note and Retry stay
            await ev(`window.__chatFail = false; window.__chatEmpty = true; true`); await key('Enter', 'Enter');
            await waitFor(`window.__reads === ${readsBefore + 2}`, `${at}the empty read was made`, 8000); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the redraw settles
            const emptied = await buttons();
            check(`${at}an empty success opens nothing either: the note and Retry stay (not expanded)`, emptied.length === 1 && emptied[0].text === 'Retry' && emptied[0].expanded === 'false' && !(await whole()) && /Could not read the whole question/.test(await rowText()), JSON.stringify(emptied));
            // the read works again: Retry opens it (the keyboard: Enter)
            await ev(`window.__chatEmpty = false; true`); await key('Enter', 'Enter');
            await waitFor(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}the whole question`, 8000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify([await buttons(), await ev('window.__reads'), await ev('window.__chatLog'), await ev('document.activeElement && document.activeElement.outerHTML.slice(0, 200)'), (await rowText() || '').slice(0, 300)])); });
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the redraw and the focus restore settle
            const open = await buttons(), t1 = await rowText(), readsAfter = await ev(`window.__reads`), mark = (t1.match(/WHOLE-(\d+)/) || [])[1];
            await shot(`needs-agent-ask-${withAsk ? 'mixed' : 'agents'}-${w}-open`);
            check(`${at}Retry opens the whole question in place (Show less, expanded), no failure note left`, open.length === 1 && open[0].text === 'Show less' && open[0].expanded === 'true' && /END-MARK/.test(t1) && !/Could not read/.test(t1), JSON.stringify(open));
            check(`${at}the whole question was read at the click through the Hub computer`, readsAfter === readsBefore + 3 && Number(mark) === readsAfter && (await ev(`window.__chatReads.every(p => /^\\/api\\/remote\\/m1\\//.test(p))`)), JSON.stringify([readsBefore, readsAfter, mark]));
            check(`${at}focus is kept on the button`, await onButton('Show less'));
            check(`${at}nothing is wider than the screen`, (await ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
            // Space closes; the line goes back; opening again does not read again
            await key(' ', 'Space');
            await waitFor(`!/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}back to the cut line`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: focus restore settles
            check(`${at}Space closes it: Show all again, focus kept`, await onButton('Show all'));
            // Tab and Shift+Tab reach it from the row's own control
            await ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => /Backend Dev/i.test(r.innerText)); const first = tr.querySelector('button.dt-primary, button.dt-mail-open, button'); first.focus(); return true; })()`);
            let reached = false; for (let i = 0; i < 8 && !reached; i++) { await tab(false); reached = await ev(`!!document.activeElement && document.activeElement.classList.contains('inbox-ask-expand')`); }
            check(`${at}Tab reaches Show all from the row's own control`, reached);
            await tab(true); check(`${at}Shift+Tab leaves it`, !(await ev(`!!document.activeElement && document.activeElement.classList.contains('inbox-ask-expand')`)));
            await ev(`document.querySelector('#group-table-view .inbox-ask-expand').focus(); true`); await key('Enter', 'Enter');
            await waitFor(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}open again`, 8000);
            const again = await rowText();
            check(`${at}opening again does not read again (the same words)`, (again.match(/WHOLE-(\d+)/) || [])[1] === mark, JSON.stringify([mark, (again.match(/WHOLE-(\d+)/) || [])[1], await ev(`window.__reads`)]));
            // the agent stops waiting and comes back with the same ask: its opened and read entries went with it (#14697), so it is closed and Show all reads again
            const readsPrune = await ev(`window.__reads`);
            await ev(`(async () => { window.__hideLong = true; const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${agents}.filter(a => a.session_id !== 'long-1'); m.updateInboxTab(); return true; })()`);
            await waitFor(`!/Backend Dev/i.test(document.getElementById('group-table-view').innerText)`, `${at}the agent stopped waiting`, 8000);
            await ev(`(async () => { window.__hideLong = false; const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${agents}; m.updateInboxTab(); return true; })()`);
            await waitFor(`/Backend Dev/i.test(document.getElementById('group-table-view').innerText)`, `${at}the agent waits again`, 8000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the rows settle
            const back = await buttons();
            check(`${at}an agent that stopped waiting and came back is closed again (its opened entry was dropped)`, back.length === 1 && back[0].text === 'Show all' && back[0].expanded === 'false' && !(await whole()), JSON.stringify(back));
            // focus moves elsewhere during a delayed read: the read finishes and opens, the focus stays where the person put it
            await ev(`window.__chatDelay = 900; document.querySelector('#group-table-view .inbox-ask-expand').focus(); true`); await key('Enter', 'Enter');
            const moved = await ev(`(() => { const i = [...document.querySelectorAll('input')].find(x => x.getClientRects().length > 0 && /^Search needs/i.test(x.placeholder || x.getAttribute('aria-label') || '')) || [...document.querySelectorAll('input')].find(x => x.getClientRects().length > 0 && x.type !== 'hidden'); window.__elsewhere = i; if (i) i.focus(); return !!i && document.activeElement === i; })()`);
            check(`${at}(setup) focus moved to a visible field while the read is on its way`, moved);
            await waitFor(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}the delayed read opens`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: any focus restore would have happened
            check(`${at}focus the person moved elsewhere during the read stays there (not pulled back to Show less)`, await ev(`!!window.__elsewhere && document.activeElement === window.__elsewhere`), JSON.stringify(await ev(`document.activeElement && document.activeElement.outerHTML.slice(0, 120)`)));
            check(`${at}the read after the turnover was made again (the cache was dropped)`, (await ev(`window.__reads`)) === readsPrune + 1, String(await ev(`window.__reads`)));
            await ev(`window.__chatDelay = 0; true`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
