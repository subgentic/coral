// The Info dialog (#4684): showInfoModal fills the agent's session info from its info route and opens the dialog, with the prompt and the message board shown only when there are
// some, the board as a link that closes the dialog and opens the board; a refusal or a failure says so in a toast and opens nothing; hideInfoModal closes it and copyInfoCommand copies the
// tmux command. It was a block of modals.js and is its own module now; this pins what it does. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            window.__m_ = await import(st + 'modals.js'); window.__state_ = (await import(st + 'state.js')).state;
            window.__answer = { body: {}, status: 200 }; window.__mcp = { body: { supported: false, servers: [] }, status: 200 }; window.__reqs = []; window.__copied = []; window.__selected = [];
            const real = window.fetch;
            window.fetch = (u, o) => { const url = String(u); if (/\\/api\\/sessions\\/live\\/[^/]+\\/mcp-servers/.test(url)) { return Promise.resolve(new Response(JSON.stringify(window.__mcp.body), { status: window.__mcp.status })); } if (/\\/api\\/sessions\\/live\\/[^/]+\\/info/.test(url)) { window.__reqs.push(url); return Promise.resolve(new Response(JSON.stringify(window.__answer.body), { status: window.__answer.status, headers: { 'content-type': 'application/json' } })); } return real(u, o); };
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
            window.selectBoardProject = key => window.__selected.push(key);
            return true; })()`);
        const text = id => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
        const shown = id => ev(`document.getElementById(${JSON.stringify(id)}).style.display`);
        const toasts = () => ev(`[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent)`);
        const open = () => ev(`document.getElementById('info-modal').style.display`);
        const run = () => ev(`window.__m_.showInfoModal().then(() => true)`);

        console.log('No live session: a toast, nothing opens');
        await ev(`window.__state_.currentSession = null; true`);
        await run();
        assert.deepEqual(await toasts(), ['No live session selected']); assert.notEqual(await open(), 'flex');

        console.log('A live agent on a board, with a prompt: every field, the board link');
        await ev(`window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' };
            window.__answer.body = { agent_name: 'info a', agent_type: 'claude', tmux_session_name: 'tm-1', tmux_command: 'tmux attach -t tm-1', working_directory: '/work/x', log_path: '/logs/x.log', pane_title: 'pane', git_repo: 'repo', git_branch: 'main', git_commit_hash: '0123456789abcdef', git_commit_subject: 'Fix it', prompt: 'You are a helper', board_name: 'team-a', board_label: 'Team A' }; true`);
        await run();
        assert.equal(await open(), 'flex');
        assert.match(await ev(`window.__reqs[0]`), /\/api\/sessions\/live\/info%20a\/info\?agent_type=claude&session_id=sid-1$/);
        assert.deepEqual(await Promise.all(['info-agent-name', 'info-agent-type', 'info-tmux-session', 'info-tmux-command', 'info-working-dir', 'info-log-path', 'info-pane-title', 'info-git-branch', 'info-git-commit', 'info-prompt'].map(text)),
            ['info a', 'claude', 'tm-1', 'tmux attach -t tm-1', '/work/x', '/logs/x.log', 'pane', 'repo : main', '01234567 Fix it', 'You are a helper']);
        assert.equal(await shown('info-prompt-label'), ''); assert.equal(await shown('info-board'), '');
        assert.equal(await ev(`document.querySelector('#info-board a').textContent`), 'Team A');
        await ev(`document.querySelector('#info-board a').click(); true`);
        assert.equal(await open(), 'none', 'the board link closes the dialog'); assert.deepEqual(await ev(`window.__selected`), ['team-a']);

        console.log('A bare agent: no prompt, no board, dashes for git');
        await ev(`window.__answer.body = { agent_name: 'info a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1', git_branch: 'dev' }; true`);
        await run();
        assert.equal(await shown('info-prompt-label'), 'none'); assert.equal(await shown('info-prompt'), 'none'); assert.equal(await shown('info-board-label'), 'none'); assert.equal(await shown('info-board'), 'none');
        assert.equal(await text('info-git-branch'), 'dev'); assert.equal(await text('info-git-commit'), '—');
        await ev(`window.__answer.body = { agent_name: 'x' }; true`); await run();
        assert.equal(await text('info-git-branch'), '—');

        console.log('MCP servers (#9769): a row of name, transport and scope when the route answers; hidden when the CLI is not read or the route refuses');
        await ev(`window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' };
            window.__answer.body = { agent_name: 'info a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1' };
            window.__mcp = { body: { supported: true, servers: [{ name: 'github', transport: 'http', scope: 'user' }, { name: 'files', transport: 'stdio', scope: 'project' }] }, status: 200 }; true`);
        await run();
        await waitFor(`document.getElementById('info-mcp').hidden === false`, 'the MCP servers row');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-mcp div')].map(d => d.textContent)`), ['github: http, user', 'files: stdio, project']);
        assert.equal(await ev(`document.getElementById('info-mcp-label').hidden`), false);
        await ev(`window.__mcp = { body: { supported: false, servers: [] }, status: 200 }; true`); await run();
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the row's fetch answers asynchronously; nothing appears
        assert.equal(await ev(`document.getElementById('info-mcp').hidden`), true, 'a CLI Coral does not read shows no row');
        await ev(`window.__mcp = { body: { error: 'no' }, status: 403 }; true`); await run();
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: as above
        assert.equal(await ev(`document.getElementById('info-mcp').hidden`), true, 'a refusal shows no row');

        console.log('Skills and Memory (#13209): the skills the agent loaded and its instruction files, a file opened read-only on a click; hidden when a route does not answer');
        await ev(`window.__sk = { body: { skills: [{ name: 'release-notes', version: 2, loads: 3, status: 'approved' }, { name: 'old', version: 1, loads: 1, status: 'removed' }] }, status: 200 };
            window.__mem = { body: { files: [{ id: 'a'.repeat(32), file: 'CLAUDE.md', kind: 'instructions', level: 'project' }] }, status: 200 };
            window.__file = { body: { text: 'Be <b>brief</b>.', truncated: false }, status: 200 };
            window.__secReqs = 0;
            const prev = window.fetch;
            window.fetch = (u, o) => { const url = String(u), reply = r => Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
                if (/\\/loaded-skills\\?/.test(url)) { window.__secReqs++; return (window.__gateSk || Promise.resolve()).then(() => reply(window.__sk)); }
                if (/\\/memory\\/[0-9a-f]{32}\\?/.test(url)) { window.__reqs.push(url); const id = url.match(/memory\\/([0-9a-f]{32})\\?/)[1], f = window.__files && window.__files[id]; return f ? f.gate.then(() => reply({ body: { text: f.text }, status: 200 })) : reply(window.__file); }
                if (/\\/memory\\?/.test(url)) { window.__secReqs++; return reply(window.__mem); }
                return prev(u, o); };
            window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' };
            window.__answer.body = { agent_name: 'info a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1' }; true`);
        await run();
        await waitFor(`document.getElementById('info-skills').hidden === false && document.getElementById('info-memory').hidden === false`, 'the Skills and Memory rows');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-skills div')].map(d => d.textContent)`), ['release-notes v2, loaded 3 times', 'old v1, loaded 1 time, removed']);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-memory button')].map(d => d.textContent)`), ['CLAUDE.md: instructions, project']);
        assert.equal(await ev(`document.getElementById('info-memory-text').hidden`), true, 'a file is opened only on a click');
        await ev(`document.querySelector('#info-memory button').click(); true`);
        await waitFor(`document.getElementById('info-memory-text').textContent === 'Be <b>brief</b>.'`, 'the file text');
        assert.equal(await ev(`document.querySelector('#info-memory-text b')`), null, 'the text is text, never markup');
        assert.match(await ev(`window.__reqs[window.__reqs.length - 1]`), /\/memory\/a{32}\?session_id=sid-1$/);
        const before = await ev(`window.__secReqs`);
        await ev(`window.__sk = { body: { error: 'no' }, status: 403 }; window.__mem = { body: { error: 'no' }, status: 403 }; true`); await run();
        await waitFor(`window.__secReqs >= ${before + 2}`, 'both refused answers'); // both rows' requests were answered: the dialog's code after them runs in the next turns of the page, so wait for those, not a fixed time
        await ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        assert.equal(await ev(`document.getElementById('info-skills').hidden && document.getElementById('info-memory').hidden`), true, 'a refusal shows no rows');
        await ev(`window.__sk = { body: { skills: [] }, status: 200 }; window.__mem = { body: { files: [] }, status: 200 }; true`); await run();
        await waitFor(`document.getElementById('info-skills').hidden === false`, 'the empty Skills row');
        assert.equal(await text('info-skills'), 'None loaded yet'); assert.equal(await text('info-memory'), 'None found');

        console.log('Stale answers (UI Reviewer, #13245 M1): an open dropped by a later open (ineligible, or after a close) writes no row when its answer comes');
        await ev(`window.__sk = { body: { skills: [{ name: 'only-local', version: 1, loads: 1, status: 'approved' }] }, status: 200 };
            window.__mem = { body: { files: [] }, status: 200 };
            window.__gateSk = new Promise(r => { window.__releaseSk = r; });
            window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' }; true`);
        const held = await ev(`window.__secReqs`);
        await run(); await waitFor(`window.__secReqs > ${held}`, 'the held skills request'); // the answer for agent A is still on its way
        await ev(`window.__state_.currentSession = { type: 'live', name: 'info b', agent_type: 'claude', session_id: '', server: 'local' }; true`);
        await run(); // the dialog opens for another agent that gets no sections (no session id: the same path a remote computer takes)
        await ev(`window.__releaseSk(); true`);
        await ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        assert.equal(await ev(`document.getElementById('info-skills').hidden`), true, 'A\'s answer arrives after the open for B: the Skills row stays hidden');
        await ev(`window.__gateSk = new Promise(r => { window.__releaseSk = r; });
            window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' }; true`);
        const held2 = await ev(`window.__secReqs`);
        await run(); await waitFor(`window.__secReqs > ${held2}`, 'the second held request');
        await ev(`window.__m_.hideInfoModal(); window.__releaseSk(); true`);
        await ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        assert.equal(await ev(`document.getElementById('info-skills').hidden`), true, 'an answer after the dialog was closed writes nothing');
        await ev(`window.__gateSk = null; true`);

        console.log('Out-of-order files (M2): the file clicked last is the one shown, whatever order the answers come in; the block names it');
        await ev(`window.__sk = { body: { skills: [] }, status: 200 };
            window.__mem = { body: { files: [{ id: 'a'.repeat(32), file: 'one.md', kind: 'memory', level: 'user' }, { id: 'b'.repeat(32), file: 'two.md', kind: 'memory', level: 'user' }] }, status: 200 };
            window.__files = {}; for (const [c, t] of [['a', 'FIRST file'], ['b', 'SECOND file']]) { const f = { text: t }; f.gate = new Promise(r => { f.release = r; }); window.__files[c.repeat(32)] = f; }
            window.__state_.currentSession = { type: 'live', name: 'info a', agent_type: 'claude', session_id: 'sid-1', server: 'local' }; true`);
        await run();
        await waitFor(`document.querySelectorAll('#info-memory button').length === 2`, 'two files');
        await ev(`const [b1, b2] = document.querySelectorAll('#info-memory button'); b1.click(); b2.click(); true`);
        await waitFor(`window.__reqs.filter(u => /\\/memory\\/[0-9a-f]{32}\\?/.test(u)).length >= 2 && window.__reqs.some(u => u.includes('b'.repeat(32)))`, 'both file requests');
        await ev(`window.__files['b'.repeat(32)].release(); true`); await waitFor(`document.getElementById('info-memory-text').textContent === 'SECOND file'`, 'the second file');
        await ev(`window.__files['a'.repeat(32)].release(); true`);
        await ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        assert.equal(await text('info-memory-text'), 'SECOND file', 'the slower first file does not overwrite the second');
        assert.equal(await ev(`document.getElementById('info-memory-text').dataset.file`), 'two.md: memory, user', 'the block names the file it shows');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-memory button')].map(b => b.getAttribute('aria-pressed'))`), ['false', 'true']);
        await ev(`window.__files = null; true`);

        console.log('Touch size (M3): at 390 px and at 200% zoom (195 px) the file buttons are at least 44 px tall, in both themes, and the dialog does not scroll sideways');
        await ev(`window.__files = null; window.__sk = { body: { skills: [{ name: 'release-notes', version: 2, loads: 3, status: 'approved' }] }, status: 200 }; true`);
        await run(); await waitFor(`document.querySelectorAll('#info-memory button').length === 2`, 'two files');
        await ev(`document.querySelector('#info-memory button').click(); true`); // a file open, read-only: the text block shows under the list
        await waitFor(`document.getElementById('info-memory-text').hidden === false`, 'the file block');
        for (const width of [390, 195]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 2, mobile: true });
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
                const m = await ev(`(() => { const bs = [...document.querySelectorAll('#info-memory button')], modal = document.getElementById('info-modal'); return { h: bs.map(b => Math.round(b.getBoundingClientRect().height)), wide: modal.scrollWidth > modal.clientWidth + 1 }; })()`);
                assert.ok(m.h.length === 2 && m.h.every(h => h >= 44), `${width} px ${theme}: both buttons are 44 px or taller: ${JSON.stringify(m)}`);
                assert.equal(m.wide, false, `${width} px ${theme}: nothing runs past the dialog's edge`);
                if (process.env.INFO_SHOTS) require('node:fs').writeFileSync(`${process.env.INFO_SHOTS}/info-sections-${width}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); // evidence for a reviewer, not part of the check
            }
        }
        await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        await Emulation.clearDeviceMetricsOverride();

        console.log('Copy and close');
        await ev(`window.__answer.body = { agent_name: 'info a', tmux_command: 'tmux attach -t zz' }; true`); await run();
        await ev(`window.__m_.copyInfoCommand(); true`);
        await waitFor(`window.__copied.length === 1`, 'the copy');
        assert.deepEqual(await ev(`window.__copied`), ['tmux attach -t zz']);
        assert.ok((await toasts()).includes('Copied to clipboard'));
        await ev(`window.__m_.hideInfoModal(); true`); assert.equal(await open(), 'none');

        console.log('A refusal and a failure: a toast, the dialog stays closed');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__answer.body = { error: 'No such agent' }; true`); await run();
        assert.deepEqual(await toasts(), ['No such agent']); assert.equal(await open(), 'none');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.fetch = () => Promise.reject(new Error('down')); true`); await run();
        assert.deepEqual(await toasts(), ['Failed to load session info']); assert.equal(await open(), 'none');
        console.log('PASS info dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
