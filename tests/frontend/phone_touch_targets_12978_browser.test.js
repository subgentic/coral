// Touch targets the keyboard audit's part 2 (#12963) listed at 24 px or less on a phone (#12978): the Skills "Show" filter was a bare select 21 px tall (it is the shared .field now: 44 px on a coarse pointer); a file row's
// Star, Copy path and More buttons (the Files panel) and the Browse row's Copy path are 24 px boxes whose hit area is 44 px through the shared .btn-icon.btn-xs rule (an ::after of -10 px), so the audit's measure
// of the box was too small: pinned here by what a finger would hit (a point 20 px above and below the button's centre reaches the button), not by the box. 390 px, coarse pointer, the real isolated dev server and a real
// agent (the mock in ready mode, in a folder with a file). Not on Windows (a script CLI).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('phone_touch_targets_12978_browser: SKIPPED (a script CLI)'); process.exit(0); }

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    let originalCli = null, wrapperDir = '', dir = '', agent = null; const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    // what a finger reaches: the points 20 px above and 20 px below the button's centre must hit the button (or something inside it)
    const reach = sel => ev(`(() => [...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = y => { const e = document.elementFromPoint(cx, y); return !!e && (e === b || b.contains(e)); }; return { name: b.getAttribute('aria-label') || b.title || b.textContent.trim().slice(0, 30), box: Math.round(r.width) + 'x' + Math.round(r.height), up: hit(cy - 20), down: hit(cy + 20), here: hit(cy) }; }))()`);
    try {
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/skills' }); await Page.loadEventFired(); await coralReady();
        await waitFor(`!!document.querySelector('#skills-view select[aria-label="Show"]')`, 'the Skills filter', { timeout: 15000 });
        const sel = await ev(`(() => { const s = document.querySelector('#skills-view select[aria-label="Show"]'); return Math.round(s.getBoundingClientRect().height); })()`);
        check('Skills Show select is a 44 px control on a phone', sel >= 44, String(sel));
        const settings = await api('GET', '/api/settings'); originalCli = settings.data && (settings.data.settings || settings.data).cli_path_claude;
        wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-tt-')); const wrapper = path.join(wrapperDir, 'claude'); fs.writeFileSync(wrapper, `#!/bin/sh\nMOCK_AGENT_READY=1 exec "${originalCli}" "$@"\n`, { mode: 0o755 });
        await api('PUT', '/api/settings', { cli_path_claude: wrapper });
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-ttagent-'))); fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');
        await api('POST', '/api/sessions/launch', { working_dir: dir, agent_type: 'claude' });
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.working_directory === ${JSON.stringify(dir)})`, 'the agent', { timeout: 20000 });
        agent = await ev(`(window._coralGetLiveSessions() || []).find(s => s.working_directory === ${JSON.stringify(dir)})`);
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await coralReady();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession(${JSON.stringify(agent.session_name || agent.name)}, 'claude', ${JSON.stringify(agent.session_id)}, ''); true`);
        await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled`, 'the composer', { timeout: 40000 });
        await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
        await waitFor(`document.querySelectorAll('#changed-files-list .file-action-btn, #changed-files-list .file-more-btn').length >= 2`, 'the Files panel row buttons', { timeout: 15000 });
        const row = await reach('#changed-files-list .file-action-btn, #changed-files-list .file-more-btn, #changed-files-list .file-star, #changed-files-list [data-on-click="file-star"]');
        check('the Files panel row has its buttons', row.length >= 2, JSON.stringify(row));
        check('each of a file row\'s buttons (Star, More) is reached 20 px above and below its centre: a 44 px hit area', row.every(b => b.here && b.up && b.down), JSON.stringify(row));
        await ev(`window.switchAgenticTab && window.switchAgenticTab('browse', 'top'); true`);
        await waitFor(`document.querySelectorAll('#agentic-panel-browse button[title="Copy path"], #agentic-panel-browse .explorer-action-btn').length >= 1`, 'the Browse row buttons', { timeout: 15000 });
        const browse = await reach('#agentic-panel-browse button[title="Copy path"]');
        check('the Browse row\'s Copy path has a 44 px hit area', browse.length >= 1 && browse.every(b => b.here && b.up && b.down), JSON.stringify(browse));
    } finally {
        if (agent) await api('POST', `/api/sessions/live/${encodeURIComponent(agent.session_name || agent.name)}/kill`, { session_id: agent.session_id, agent_type: 'claude' }).catch(() => {});
        if (originalCli) await api('PUT', '/api/settings', { cli_path_claude: originalCli }).catch(() => {});
        for (const d of [dir, wrapperDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the folder stays */ } }
        await client.close();
    }
    assert.deepEqual(problems, [], 'phone touch targets:\n  ' + problems.join('\n  '));
    console.log('PASS phone touch targets: the Skills filter is 44 px, the file rows\' buttons have a 44 px hit area');
})().catch(e => { console.error(e); process.exit(1); });
