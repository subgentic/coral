// #14637 (1): a waiting agent's own question ("Wants to know: ...") that the server's 200-character summary cut gets Show all like an Operator question (#14617): the click reads the whole question once from the agent's chat state (through the Hub: /api/remote/m1/...),
// the row says it in place, Show less goes back to the summary, opening again does not read again, a short question has no button, and the keyboard (Tab, Enter) does it with focus kept. Through the stubbed Hub world, 1280 and 390 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code) => { const enter = k === 'Enter'; await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: enter ? 13 : 32, text: enter ? '\r' : ' ' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: enter ? 13 : 32 }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            const agents = `(() => { const long = 'Wants to know: ' + 'Which of the two storage layouts do we keep for the launch, given the migration cost and the rollback plan? '.repeat(1).slice(0, 184) + '\\u2026'; const agent = (id, name, summary) => ({ session_id: id, name: id, display_name: name, agent_type: 'claude', working_directory: '/repo/' + id, server: 'm1', sleeping: false, archived: false, status: 'idle', waiting_for_input: true, waiting_kind: 'question', waiting_summary: summary, waiting_since: new Date(Date.now() - 120000).toISOString() }); return [agent('long-1', 'Backend Dev', long), agent('short-1', 'Designer', 'Wants to know: Red or blue?')]; })()`;
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })); window.__chatReads = []; window.__reads = 0;
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/);
                    if (u.pathname === '/api/sessions/live') return json({ sessions: ${agents} });
                    if (mm && mm[2] === '/api/operator-asks') return json(mm[1] === 'm1' ? [{ board: 'team-x', kind: 'ask', id: 7, asker: 'Planner', text: 'Ship tonight or wait?', cut: false, at: new Date(Date.now() - 60000).toISOString() }] : []); // one short question to the Operator: the rows are item rows (a team with only waiting agents has one-line mail rows, which have no Show all)
                    if (mm && mm[2] === '/api/needs-you' && /kind=skill/.test(u.search)) return json({ count: 0, counts: { skill: 0 }, items: [] });
                    if (mm && /^\\/api\\/sessions\\/live\\/long-1\\/chat$/.test(mm[2])) { window.__chatReads.push(u.pathname); window.__reads++; return json({ messages: [], total: 0, prompt_options: { question: 'WHOLE-' + window.__reads + ' ' + 'Which storage layout do we keep for the launch, given the migration cost, the rollback plan and the backup window? '.repeat(4) + 'END-MARK', ask_id: 'a1', options: [] } }); }
                    return original(url, opts); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${agents}; m.updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 3`, `${at}two waiting agents and a question`, 15000);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the rows settle
            const rowText = i => ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => ${JSON.stringify(i)} === 'long' ? /Backend Dev/.test(r.innerText) : /Designer/.test(r.innerText)); return tr ? tr.innerText : null; })()`);
            const buttons = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-ask-expand')].map(b => ({ text: b.textContent, expanded: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label') }))`);
            const before = await buttons(), t0 = await rowText('long');
            await shot(`needs-agent-ask-${w}-before`);
            check(`${at}one Show all, on the cut question only (the short one has none)`, before.length === 1 && before[0].text === 'Show all' && before[0].expanded === 'false' && /Backend Dev/.test(before[0].label), JSON.stringify(before) + (before.length ? '' : ' ' + await ev(`([...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => /Backend Dev/.test(r.innerText)) || {}).outerHTML.slice(0, 3500)`)));
            check(`${at}the row says the server's cut line, not the whole question yet`, /…/.test(t0) && !/END-MARK/.test(t0), JSON.stringify(t0).slice(0, 300));
            const readsBefore = await ev(`window.__reads`);
            // the keyboard: focus the button, Enter
            await ev(`document.querySelector('#group-table-view .inbox-ask-expand').focus(); true`);
            await key('Enter', 'Enter');
            await waitFor(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}the whole question`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the redraw and the focus restore settle
            const open = await buttons(), t1 = await rowText('long'), readsAfter = await ev(`window.__reads`), mark = (t1.match(/WHOLE-(\d+)/) || [])[1];
            await shot(`needs-agent-ask-${w}-open`);
            check(`${at}Enter opens the whole question in place (Show less, expanded)`, open.length === 1 && open[0].text === 'Show less' && open[0].expanded === 'true' && /END-MARK/.test(t1), JSON.stringify(open));
            check(`${at}the whole question was read at the click (a read after the first paint's), through the Hub computer`, readsAfter > readsBefore && Number(mark) > readsBefore && (await ev(`window.__chatReads.every(p => /^\\/api\\/remote\\/m1\\//.test(p))`)), JSON.stringify([readsBefore, readsAfter, mark]));
            check(`${at}focus is kept on the button`, await ev(`document.activeElement && document.activeElement.classList.contains('inbox-ask-expand') && document.activeElement.textContent === 'Show less'`));
            check(`${at}nothing is wider than the screen`, (await ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
            // Space closes; the line goes back; opening again does not read again
            await key(' ', 'Space');
            await waitFor(`!/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}back to the cut line`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: focus restore settles
            check(`${at}Space closes it: Show all again, focus kept`, await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-ask-expand'); return !!b && b.textContent === 'Show all' && document.activeElement === b; })()`));
            await key('Enter', 'Enter');
            await waitFor(`/END-MARK/.test(document.getElementById('group-table-view').innerText)`, `${at}open again`, 8000);
            const again = await rowText('long');
            check(`${at}opening again does not read again (the same words)`, (again.match(/WHOLE-(\d+)/) || [])[1] === mark, JSON.stringify([mark, (again.match(/WHOLE-(\d+)/) || [])[1], await ev(`window.__reads`)]));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
