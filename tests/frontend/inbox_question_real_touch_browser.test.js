// #20429 (v2.1.3 beta walk item 3): a real agent's question (the mock CLI in ready mode, MOCK_ASK_QUESTION: "Pick a color:", Red or Blue) is answered by ONE touch of its choice in Needs you at 390 px,
// the way a permission's Yes is: the first touch sends the answer, it does not open the agent's chat. Touch emulation on, a native touch at the choice's centre (Input.dispatchTouchEvent), the real server and the real prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('inbox_question_real_touch_browser: SKIPPED (POSIX CLI wrapper)'); process.exit(0); }
(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Input } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async expression => { const r = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json().catch(()=>null)}))`);
    let original, agent, team = '', dir = '';
    try {
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await coralReady();
        original = (await api('GET', '/api/settings')).data.settings || (await api('GET', '/api/settings')).data;
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-question-')));
        const cli = path.join(dir, 'claude');
        fs.writeFileSync(cli, `#!/bin/sh\nMOCK_AGENT_READY=1 exec '${String(original.cli_path_claude).replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
        assert.equal((await api('PUT', '/api/settings', { cli_path_claude: cli })).status, 200);
        const launched = await api('POST', '/api/sessions/launch', { working_dir: dir, agent_type: 'claude', display_name: 'Question Agent', board_name: 'question-' + Date.now() });
        assert.ok(launched.status < 300, JSON.stringify(launched));
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.working_directory===${JSON.stringify(dir)}&&!s.waiting_for_input)`, 'the agent is up', { timeout: 40000 });
        agent = await ev(`window._coralGetLiveSessions().find(s=>s.working_directory===${JSON.stringify(dir)})`); team = agent.board_project;
        const sent = await api('POST', `/api/sessions/live/${encodeURIComponent(agent.session_name || agent.name)}/send`, { command: 'MOCK_ASK_QUESTION', agent_type: 'claude', session_id: agent.session_id });
        assert.ok(sent.status < 300, JSON.stringify(sent));
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(agent.session_id)}&&s.waiting_for_input&&s.waiting_kind==='question')`, 'the question is a wait in the feed', { timeout: 30000 });
        await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
        await waitFor(`!!document.querySelector('#group-table-view .inbox-answer[data-session="${agent.session_id}"]')`, 'the question row has its choices', { timeout: 20000 });
        const tap = await ev(`(()=>{const b=document.querySelector('#group-table-view .inbox-answer[data-session="${agent.session_id}"]');b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,label:b.textContent,hit:!!hit&&(hit===b||b.contains(hit)),html:hit?.outerHTML.slice(0,250)};})()`);
        assert.ok(tap.hit, 'the choice receives its centre touch: ' + JSON.stringify(tap));
        await Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: tap.x, y: tap.y }] });
        await Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
        await waitFor(`!(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(agent.session_id)}&&s.waiting_for_input)||[...document.querySelectorAll('#group-table-view .inbox-answered')].some(e=>/Answered/.test(e.textContent))||document.body.dataset.navTab!=='hub-inbox'`, 'one touch decided something', { timeout: 15000 });
        assert.equal(await ev(`document.body.dataset.navTab`), 'hub-inbox', 'one touch of ' + tap.label + ' answers the question; it does not open the agent (nav tab: ' + await ev(`document.body.dataset.navTab`) + ')');
        await waitFor(`!(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(agent.session_id)}&&s.waiting_for_input)`, 'the agent got the answer and stopped waiting', { timeout: 20000 });
        console.log('PASS a real question is answered by one native touch at 390');
    } finally {
        if (!agent && dir) agent = await ev(`(window._coralGetLiveSessions?.()||[]).find(s=>s.working_directory===${JSON.stringify(dir)})`).catch(() => null);
        if (agent) await api('POST', `/api/sessions/live/${encodeURIComponent(agent.session_name || agent.name)}/kill`, { session_id: agent.session_id, agent_type: 'claude' }).catch(() => {});
        if (original) await api('PUT', '/api/settings', { cli_path_claude: original.cli_path_claude }).catch(() => {});
        if (team) await require('./helpers/board_cleanup').removeBoards(ev, [team]).catch(() => {});
        await client.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
