// #18752: with none of Claude, Codex or Antigravity installed, a new install's Inbox starts with a "Get set up" row, and New agent / New team open the same set-up dialog instead of the launch form. One ready: no row, no dialog.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { install: installTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev); await stubModels(ev);
        // cli-check answers from window.__ready (flipped by the test); settings writes are kept in window.__puts.
        await ev(`(() => { const real = window.fetch; window.__ready = { claude: false, codex: false, agy: false }; window.__puts = [];
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/system/cli-check') { const t = url.searchParams.get('type') || 'claude'; return Promise.resolve(Response.json({ agent_type: t, found: !!window.__ready[t], status: window.__ready[t] ? 'ok' : 'missing' })); }
                if (p === '/api/board/projects') return Promise.resolve(Response.json([]));
                if (p === '/api/settings' && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); return Promise.resolve(Response.json({ ok: true })); }
                return real(u, o); };
            window.T.state.settings = { ...window.T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '', inbox_welcome_setup: 'on', default_agent_type: 'claude' }; window.T.state.liveSessions = []; window.T.state.servers = []; window.switchNavTab('hub-inbox'); return true; })()`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        const titles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(h => h.textContent.trim())`);
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(h => /Get set up with Claude, Codex or Antigravity/.test(h.textContent))`, 'the set-up row appears while none is installed');
        const first = (await titles())[0];
        assert.match(first, /Get set up with Claude, Codex or Antigravity/, 'it is the first row: ' + first);
        assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length`), 6, 'the five welcome rows and the set-up row');
        // The row's button opens the dialog: three providers, none installed, and the install line of each.
        await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-actions button')].find(b => b.textContent === 'Set up an agent').click(); true`);
        await waitFor(`!!document.getElementById('setup-agent-modal') && [...document.querySelectorAll('#setup-agent-modal .setup-agent-status')].every(s => s.textContent === 'Not installed')`, 'the dialog says none is installed');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#setup-agent-modal .setup-agent-top b')].map(b => b.textContent)`), ['Claude Code', 'Codex', 'Antigravity']);
        await ev(`document.querySelector('#setup-agent-modal .setup-agent-top button').click(); true`);
        assert.match(await ev(`document.querySelector('#setup-agent-modal .setup-agent-steps code').textContent`), /npm install -g @anthropic-ai\/claude-code/, 'Claude\'s own install line');
        // Codex gets installed: Check again says so, Continue ends it, the row goes and the default follows the agent that is ready.
        await ev(`window.__ready.codex = true; [...document.querySelectorAll('#setup-agent-modal .modal-actions button')].find(b => b.textContent === 'Check again').click(); true`);
        await waitFor(`/Codex is ready/.test(document.querySelector('#setup-agent-modal .setup-agent-result').textContent)`, 'Check again finds Codex');
        await ev(`[...document.querySelectorAll('#setup-agent-modal .modal-actions button')].find(b => b.textContent === 'Continue').click(); true`);
        await waitFor(`!document.getElementById('setup-agent-modal') && ![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(h => /Get set up/.test(h.textContent))`, 'the dialog closes and the row is gone');
        const puts = await ev(`window.__puts`);
        assert.ok(puts.some(p => p.inbox_welcome_setup === 'off'), 'the row is turned off for good: ' + JSON.stringify(puts));
        assert.ok(puts.some(p => p.default_agent_type === 'codex'), 'the default agent follows the one that is ready (it was Claude, not installed): ' + JSON.stringify(puts));
        // The gate: with none installed, New agent opens the set-up dialog, not the launch form; Continue then opens the launch form.
        await ev(`window.__ready.codex = false; window.T.state.settings.default_agent_type = 'claude'; import((window.__coralStatic || '/static/') + 'setup_agent.js').then(m => m.readyProviders(true)).then(() => true)`);
        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await waitFor(`!!document.getElementById('setup-agent-modal')`, 'New agent with none installed opens the set-up dialog');
        assert.notEqual(await ev(`getComputedStyle(document.getElementById('launch-modal')).display`), 'flex', 'in place of the launch form');
        await ev(`window.__ready.claude = true; [...document.querySelectorAll('#setup-agent-modal .modal-actions button')].find(b => b.textContent === 'Check again').click(); true`);
        await waitFor(`/Claude Code is ready/.test(document.querySelector('#setup-agent-modal .setup-agent-result').textContent)`, 'Claude found');
        await ev(`[...document.querySelectorAll('#setup-agent-modal .modal-actions button')].find(b => b.textContent === 'Continue').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-modal')).display === 'flex' && !!document.getElementById('launch-step-agent') && document.getElementById('launch-step-agent').style.display !== 'none'`, 'Continue opens the New agent form');
        await ev(`window.hideLaunchModal(); true`);
        // With one installed there is no dialog at all.
        await ev(`import((window.__coralStatic || '/static/') + 'setup_agent.js').then(m => m.readyProviders(true)).then(() => true)`);
        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: give a wrongly opened dialog time to appear
        assert.equal(await ev(`!!document.getElementById('setup-agent-modal')`), false, 'one agent installed: New agent goes straight to the form');
        console.log('PASS the set-up row and the New agent gate');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
