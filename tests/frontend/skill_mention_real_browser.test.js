// The $ skills menu end to end on the real routes (#12766, goal #207): the isolated dev server, one of the approved starter skills it seeds, a real agent (the runner's mock in ready mode, launched through the API
// and open in the real dashboard), "$" and the first letters of the skill's name typed in its message box, the menu lists the skill from GET /api/skills/search, Enter attaches it through
// POST /api/sessions/live/<name>/skills and puts the route's line in the box. Nothing is stubbed. The attach is checked on the server: a second attach of the same skill answers "already", so the first one made
// the row. Not on Windows (a script CLI). Not checked here: that the agent reads the skill in its next turn (that is the agent's side: `coral-agent skills get` with its own key).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('skill_mention_real_browser: SKIPPED (a script CLI)'); process.exit(0); }

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation, Input } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    const key = async k => { const code = { Enter: 13, ArrowDown: 40 }[k]; await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    let originalCli = null, wrapperDir = '', dir = '', agent = null;
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        // one approved skill: the starter skills this server seeded (approved, published by Coral)
        const list = await api('GET', '/api/skills?status=approved');
        assert.equal(list.status, 200, 'the approved skills: ' + JSON.stringify(list));
        const skill = (list.data.skills || []).find(s => /^[a-z]{3,}/i.test(s.name));
        assert.ok(skill, 'the server seeds at least one approved skill: ' + JSON.stringify(list.data));
        const prefix = skill.name.slice(0, 2).toLowerCase();
        // a real agent: the mock in ready mode as the Claude CLI
        const settings = await api('GET', '/api/settings');
        originalCli = settings.data && (settings.data.settings || settings.data).cli_path_claude;
        assert.ok(originalCli, 'the runner points cli_path_claude at the mock');
        wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-skillmock-'));
        const wrapper = path.join(wrapperDir, 'claude');
        fs.writeFileSync(wrapper, `#!/bin/sh\nMOCK_AGENT_READY=1 exec "${originalCli}" "$@"\n`, { mode: 0o755 });
        assert.equal((await api('PUT', '/api/settings', { cli_path_claude: wrapper })).status, 200);
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-skillagent-')));
        const res = await api('POST', '/api/sessions/launch', { working_dir: dir, agent_type: 'claude' });
        assert.ok(res.status < 300, 'launch: ' + JSON.stringify(res));
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.working_directory === ${JSON.stringify(dir)})`, 'the new agent in the live list', { timeout: 20000 });
        agent = await ev(`(window._coralGetLiveSessions() || []).find(s => s.working_directory === ${JSON.stringify(dir)})`);
        const name = agent.session_name || agent.name;
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(agent.session_id)}, ''); true`);
        await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled`, 'the message box of the real agent', { timeout: 40000 });
        await ev(`window.__seen = []; { const R = window.fetch; window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname; if (/skills/.test(p)) window.__seen.push([(o && o.method) || 'GET', p]); return R(u, o); }; } document.getElementById('command-input').focus(); true`);

        // $ and the first letters: the real search lists the real skill
        await Input.insertText({ text: '$' + prefix });
        await waitFor(`(() => { const d = document.querySelector('.skill-mention-dropdown'); return !!d && getComputedStyle(d).display !== 'none' && [...d.querySelectorAll('.skill-name')].some(n => n.textContent === ${JSON.stringify(skill.name)}); })()`, 'the real skill in the menu', { timeout: 10000 });
        const row = await ev(`(() => { const n = [...document.querySelectorAll('.skill-mention-item')].find(i => i.querySelector('.skill-name').textContent === ${JSON.stringify(skill.name)}); return { name: n.querySelector('.skill-name').textContent, desc: n.querySelector('.skill-desc').textContent }; })()`);
        assert.ok(row.desc.length > 0, 'the row carries the skill\'s one line: ' + JSON.stringify(row));
        assert.ok((await ev(`window.__seen`)).some(x => x[0] === 'GET' && x[1] === '/api/skills/search'), 'the menu asked the search route');
        // move to the skill's row and pick it
        const idx = await ev(`[...document.querySelectorAll('.skill-mention-item')].findIndex(i => i.querySelector('.skill-name').textContent === ${JSON.stringify(skill.name)})`);
        for (let i = 0; i < idx; i++) await key('ArrowDown');
        await key('Enter');
        const LINE = `Use the skill ${skill.name} (coral-agent skills get --id ${skill.id}).`;
        await waitFor(`document.getElementById('command-input').value.startsWith(${JSON.stringify(LINE)})`, 'the route\'s line in the box', { timeout: 10000 });
        assert.equal(await ev(`document.getElementById('command-input').value`), LINE + ' ', 'the "$' + prefix + '" is replaced by the route\'s line and a space');
        assert.ok((await ev(`window.__seen`)).some(x => x[0] === 'POST' && x[1] === `/api/sessions/live/claude-${agent.session_id}/skills`), 'the pick asked the attach route of this agent, by the name the route takes (<cli>-<session id>)');
        // the attach row is on the server: a second attach of the same skill says it was already there
        const again = await api('POST', `/api/sessions/live/claude-${agent.session_id}/skills?session_id=${encodeURIComponent(agent.session_id)}`, { skill_id: skill.id });
        assert.equal(again.status, 200, 'a second attach: ' + JSON.stringify(again));
        assert.equal(again.data.already, true, 'the first attach made the row (a second one says already): ' + JSON.stringify(again.data));
        assert.equal(again.data.line, LINE, 'the route answers with the same line');
        console.log('PASS the $ menu on the real routes: ' + skill.name + ' listed, attached to a real agent, its line in the box');
    } finally {
        if (agent) await api('POST', `/api/sessions/live/${encodeURIComponent(agent.session_name || agent.name)}/kill`, { session_id: agent.session_id, agent_type: 'claude' }).catch(() => {});
        if (originalCli) await api('PUT', '/api/settings', { cli_path_claude: originalCli }).catch(() => {});
        for (const d of [dir, wrapperDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the folder stays */ } }
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
