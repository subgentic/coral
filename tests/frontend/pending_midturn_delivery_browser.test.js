// #16464: real composer/send, mock CLI, Claude JSONL reader and live chat.
// No live-list, history or send responses are mocked. The runner owns all data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('SKIP shell mock wrapper on Windows'); process.exit(0); }
(async () => {
    const { client, Page, ev, waitFor } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json()}))`);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-midturn-')));
    let originalCli, row;
    const messages = ['MIDTURN-PLAIN Please focus on this test', 'MIDTURN-QUEUED Please prepare a test build'];
    const select = async () => { await ev(`(async()=>{await window.selectLiveSession(${JSON.stringify(row.session_name || row.name)},'claude',${JSON.stringify(row.session_id)},'');window.setLiveViewMode('chat');return true;})()`); };
    const delivered = async label => {
        await waitFor(`(()=>{const c=document.getElementById('live-history-messages');const turns=[...c.querySelectorAll('.human:not(.pending) .message-text')].map(e=>e.textContent);return ${JSON.stringify(messages)}.every(t=>turns.some(s=>s.includes(t)))&&!c.querySelector('.chat-bubble.pending');})()`, label, 20000);
        console.log('PASS', label);
    };
    try {
        await Page.enable();
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        const settings = (await api('GET','/api/settings')).data;
        originalCli = (settings.settings || settings).cli_path_claude;
        assert.ok(originalCli && /mock-agent/.test(originalCli), 'isolated runner mock CLI');
        const wrapper = path.join(dir, 'claude');
        fs.writeFileSync(wrapper, '#!/bin/sh\nMOCK_AGENT_READY=1 MOCK_AGENT_MIDTURN=1 exec ' + "'" + originalCli.replace(/'/g, "'\\''") + "'" + ' "$@"\n', { mode: 0o755 });
        assert.equal((await api('PUT','/api/settings',{cli_path_claude:wrapper})).status,200);
        assert.equal((await api('POST','/api/sessions/launch',{working_dir:dir,agent_type:'claude'})).status,200);
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.working_directory===${JSON.stringify(dir)}&&!s.starting)`, 'mock live row ready', 25000);
        row = await ev(`window._coralGetLiveSessions().find(s=>s.working_directory===${JSON.stringify(dir)})`);
        await select();
        const send = async text => { await ev(`(async()=>{const c=await import((window.__coralStatic||'/static/')+'controls.js');document.getElementById('command-input').value=${JSON.stringify(text)};await c.sendCommand();return true;})()`); };
        await send('MOCK_BUSY 90');
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(row.session_id)}&&s.working)`, 'open busy turn', 15000);
        for (const message of messages) await send(message);
        await delivered('both delivered mid-turn without reload');
        assert.equal(await ev(`(window._coralGetLiveSessions()||[]).find(s=>s.session_id===${JSON.stringify(row.session_id)})?.working`), true, 'turn remains working when receipts clear');
        await ev(`window.switchNavTab('history');true`);
        await waitFor(`location.pathname === '/chats'`, 'left agent chat for Chats tab', 10000);
        await ev(`window.switchNavTab('agents');true`); await select();
        await delivered('both delivered after switching tabs');
        await Page.reload(); await Page.loadEventFired(); await coralReady();
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(row.session_id)})`, 'live row after reload', 15000);
        await select(); await delivered('both delivered after reload');
    } finally {
        if (row) await api('POST',`/api/sessions/live/${encodeURIComponent(row.session_name || row.name)}/kill`,{agent_type:'claude',session_id:row.session_id}).catch(()=>{});
        if (originalCli) await api('PUT','/api/settings',{cli_path_claude:originalCli}).catch(()=>{});
        await client.close();
    }
})().catch(e=>{console.error(e);process.exit(1);});
