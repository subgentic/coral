// The right sidebar's Info tab (#13917, goals #217 and #218): everything the Info dialog (#4684) showed, in one tab of the agent's page, and under it the agent's MCP servers (#9769), the skills it loaded and its instruction and memory
// files (#13209), read-only. The dialog is gone; the Info button of an agent's menu opens this tab.
// Pins: the tab is on the agent page and in its URL sub-tabs; the fields fill from the info route (the prompt and the message board only when there are some, the board as a link, the own-terminal note, an error answer says so);
// the three sections fill from their routes and a file opens only on a click, as text; a refusal or a failure leaves a section out; an agent with no session id (the path a remote computer takes) has its fields and asks for no section;
// a stale answer (another agent, the tab shown again) writes nothing; out-of-order files show the one clicked last; the Copy button copies the attach command; openInfoTab opens the dock on the tab; at 390 px with the root text at
// 100% and 200%, in both themes, the buttons are 44 px, nothing runs past the panel or sideways, and a file opens from the keyboard. There is no Info dialog left in the page.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
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
            window.__state_ = (await import(st + 'state.js')).state; window.__routes_ = await import(st + 'routes.js'); window.__tab_ = await import(st + 'info_tab.js');
            window.__answer = { body: { agent_name: 'tab a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1' }, status: 200 };
            window.__mcp = { body: { supported: true, servers: [{ name: 'github', transport: 'http', scope: 'user' }, { name: 'files', transport: 'stdio', scope: 'project' }] }, status: 200 };
            window.__sk = { body: { skills: [{ name: 'release-notes', version: 2, loads: 3, status: 'approved' }, { name: 'old', version: 1, loads: 1, status: 'removed' }] }, status: 200 };
            window.__mem = { body: { files: [{ id: 'a'.repeat(32), file: 'CLAUDE.md', kind: 'instructions', level: 'project' }] }, status: 200 };
            window.__file = { body: { text: 'Be <b>brief</b>.', truncated: false }, status: 200 };
            window.__reqs = []; window.__files = null; window.__gateSk = null; window.__selected = []; window.__copied = [];
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
            window.selectBoardProject = key => window.__selected.push(key);
            const prev = window.fetch, reply = r => Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
            window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/info\\?/.test(url)) { window.__reqs.push(url); return reply(window.__answer); }
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/mcp-servers\\?/.test(url)) { window.__reqs.push(url); return reply(window.__mcp); }
                if (/\\/loaded-skills\\?/.test(url)) { window.__reqs.push(url); return (window.__gateSk || Promise.resolve()).then(() => reply(window.__sk)); }
                if (/\\/memory\\/[0-9a-f]{32}\\?/.test(url)) { window.__reqs.push(url); const id = url.match(/memory\\/([0-9a-f]{32})\\?/)[1], f = window.__files && window.__files[id]; return f ? f.gate.then(() => reply({ body: { text: f.text }, status: 200 })) : reply(window.__file); }
                if (/\\/memory\\?/.test(url)) { window.__reqs.push(url); return reply(window.__mem); }
                return prev(u, o); };
            return true; })()`);
        const live = (name, sid) => ev(`window.__state_.currentSession = { type: 'live', name: ${JSON.stringify(name)}, agent_type: 'claude', session_id: ${JSON.stringify(sid)}, server: 'local' }; true`);
        const show = () => ev(`window.__tab_.showInfoTab().then(() => true)`);
        const hidden = id => ev(`document.getElementById(${JSON.stringify(id)}).hidden`);
        const text = id => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
        const turns = () => ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        const askedCount = () => ev(`window.__reqs.length`);
        const toasts = () => ev(`[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent)`);
        const sections = path => ev(`window.__reqs.filter(u => /loaded-skills|\\/memory|mcp-servers/.test(u)).length`);

        console.log('The tab is on the agent page and in its URL sub-tabs; there is no Info dialog left');
        assert.equal(await ev(`document.getElementById('agentic-tab-info').getAttribute('aria-label')`), 'Info');
        assert.equal(await ev(`document.querySelector('#agentic-tab-info .agentic-tab-word').textContent`), 'Info');
        assert.equal(await ev(`!!document.getElementById('agentic-panel-info')`), true);
        assert.equal(await ev(`window.__routes_.AGENT_SUBTABS.includes('info')`), true);
        assert.equal(await ev(`!!document.getElementById('info-modal') || !!document.querySelector('template[data-lazy="info-modal"]') || typeof window.showInfoModal === 'function'`), false, 'no dialog, no template, no opener');

        console.log('Switching to the tab fills it: the fields, then the three sections');
        await live('tab a', 'sid-1');
        await ev(`window.__answer.body = { agent_name: 'tab a', agent_type: 'claude', tmux_session_name: 'tm-1', tmux_command: 'tmux attach -t tm-1', working_directory: '/work/x', log_path: '/logs/x.log', pane_title: 'pane', git_repo: 'repo', git_branch: 'main', git_commit_hash: '0123456789abcdef', git_commit_subject: 'Fix it', prompt: 'You are a helper', board_name: 'team-a', board_label: 'Team A' }; window.switchAgenticTab('info', 'top'); true`);
        await waitFor(`document.getElementById('info-mcp').hidden === false && document.getElementById('info-skills').hidden === false && document.getElementById('info-memory').hidden === false`, 'the three sections');
        assert.equal(await ev(`document.getElementById('agentic-panel-info').classList.contains('active')`), true, 'switching to Info opens its panel');
        assert.match(await ev(`window.__reqs[0]`), /\/api\/sessions\/live\/tab%20a\/info\?agent_type=claude&session_id=sid-1$/);
        assert.deepEqual(await Promise.all(['info-agent-name', 'info-agent-type', 'info-tmux-session', 'info-tmux-command', 'info-working-dir', 'info-log-path', 'info-pane-title', 'info-git-branch', 'info-git-commit', 'info-prompt'].map(text)),
            ['tab a', 'claude', 'tm-1', 'tmux attach -t tm-1', '/work/x', '/logs/x.log', 'pane', 'repo : main', '01234567 Fix it', 'You are a helper']);
        assert.equal(await hidden('info-prompt-label'), false); assert.equal(await hidden('info-board'), false);
        assert.equal(await ev(`document.querySelector('#info-board a').textContent`), 'Team A');
        await ev(`document.querySelector('#info-board a').click(); true`);
        assert.deepEqual(await ev(`window.__selected`), ['team-a'], 'the board link opens the board');
        assert.equal(await hidden('info-attach-note'), true); assert.equal(await hidden('info-copy-btn'), false);

        console.log('Copy: the attach command goes to the clipboard');
        await ev(`document.getElementById('info-copy-btn').click(); true`);
        await waitFor(`window.__copied.length === 1`, 'the copy'); assert.deepEqual(await ev(`window.__copied`), ['tmux attach -t tm-1']);
        assert.ok((await toasts()).includes('Copied to clipboard'));

        console.log('A bare agent on Coral\'s own terminal: no prompt, no board, dashes for git, the note says why there is nothing to attach to');
        await ev(`window.__answer.body = { agent_name: 'tab a', agent_type: 'claude', git_branch: 'dev' }; true`); await show();
        assert.equal(await hidden('info-prompt-label'), true); assert.equal(await hidden('info-prompt'), true); assert.equal(await hidden('info-board-label'), true); assert.equal(await hidden('info-board'), true);
        assert.equal(await text('info-git-branch'), 'dev'); assert.equal(await text('info-git-commit'), '—');
        assert.equal(await hidden('info-attach-note'), false); assert.equal(await hidden('info-copy-btn'), true); assert.equal(await hidden('info-tmux-command'), true);
        assert.match(await text('info-attach-note'), /nothing to attach to/);
        await ev(`window.__answer.body = { agent_name: 'x' }; true`); await show();
        assert.equal(await text('info-git-branch'), '—');
        await ev(`window.__answer.body = { agent_name: 'tab a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1' }; true`);

        console.log('The info route refuses or fails: a toast and a line in the tab, no fields');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__answer = { body: { error: 'No such agent' }, status: 200 }; true`); await show();
        assert.deepEqual(await toasts(), ['No such agent']); assert.equal(await text('info-tab-note'), 'No such agent'); assert.equal(await hidden('info-tab-grid'), true);
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__answer = { body: { agent_name: 'tab a', agent_type: 'claude', tmux_command: 'tmux attach -t tm-1' }, status: 200 }; const f = window.fetch; window.fetch = (u, o) => /\\/info\\?/.test(String(u)) ? Promise.reject(new Error('down')) : f(u, o); window.__restoreFetch = () => { window.fetch = f; }; true`); await show();
        assert.deepEqual(await toasts(), ['Failed to load session info']); assert.match(await text('info-tab-note'), /Could not load/);
        await ev(`window.__restoreFetch(); true`); await show();
        assert.equal(await hidden('info-tab-grid'), false, 'the next look shows the fields again'); assert.equal(await hidden('info-tab-note'), true);

        console.log('The sections: MCP servers, skills, memory files; a file opens only on a click, as text, read-only');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-mcp div')].map(d => d.textContent)`), ['github: http, user', 'files: stdio, project']);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-skills div')].map(d => d.textContent)`), ['release-notes v2, loaded 3 times', 'old v1, loaded 1 time, removed']);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-memory button')].map(d => d.textContent)`), ['CLAUDE.md: instructions, project']);
        assert.equal(await ev(`document.getElementById('info-memory-text').hidden`), true, 'a file is opened only on a click');
        await ev(`document.querySelector('#info-memory button').click(); true`);
        await waitFor(`document.getElementById('info-memory-text').textContent === 'Be <b>brief</b>.'`, 'the file text');
        assert.equal(await ev(`document.querySelector('#info-memory-text b')`), null, 'the text is text, never markup');
        assert.match(await ev(`window.__reqs[window.__reqs.length - 1]`), /\/memory\/a{32}\?session_id=sid-1$/);
        assert.equal(await ev(`document.querySelectorAll('#info-tab-grid input, #info-tab-grid textarea, #info-tab-grid [contenteditable]').length`), 0, 'read-only: nothing to edit');

        console.log('Refusals and failures: a section is left out and keeps nothing from the last look; an empty answer says none');
        await ev(`window.__mcp = { body: { error: 'no' }, status: 403 }; window.__sk = { body: { error: 'no' }, status: 403 }; window.__mem = { body: { error: 'no' }, status: 403 }; true`);
        await show();
        assert.equal(await ev(`['info-mcp', 'info-skills', 'info-memory'].every(id => document.getElementById(id).hidden && document.getElementById(id).childElementCount === 0)`), true, 'a refusal shows no section');
        assert.equal(await hidden('info-tab-grid'), false, 'the fields stay');
        await ev(`window.__mcp = { body: { supported: false, servers: [] }, status: 200 }; window.__sk = { body: { skills: [] }, status: 200 }; window.__mem = { body: { files: [] }, status: 200 }; true`);
        await show();
        assert.equal(await hidden('info-mcp'), true, 'a CLI Coral does not read has no MCP section');
        assert.equal(await text('info-skills'), 'None loaded yet'); assert.equal(await text('info-memory'), 'None found');

        console.log('No session id (what a remote computer\'s agent has): the fields, and no request for a section; no live agent: one line');
        await ev(`window.__mcp = { body: { supported: true, servers: [{ name: 'x', transport: 'stdio', scope: 'user' }] }, status: 200 }; window.__sk = { body: { skills: [{ name: 's', version: 1, loads: 1 }] }, status: 200 }; true`);
        const before = await sections();
        await live('tab remote', ''); await show();
        assert.equal(await sections(), before, 'no section request for an agent without a session id');
        assert.equal(await hidden('info-tab-grid'), false); assert.equal(await text('info-agent-name'), 'tab a', 'its fields came from the info route'); assert.equal(await hidden('info-mcp'), true);
        await ev(`window.__state_.currentSession = null; true`); await show();
        assert.match(await text('info-tab-note'), /Pick an agent/); assert.equal(await hidden('info-tab-grid'), true);

        console.log('Stale answers: an answer for an earlier look (another agent, the tab shown again) writes nothing');
        await ev(`window.__mem = { body: { files: [] }, status: 200 }; window.__sk = { body: { skills: [{ name: 'only-a', version: 1, loads: 1, status: 'approved' }] }, status: 200 };
            window.__gateSk = new Promise(r => { window.__releaseSk = r; }); true`);
        await live('tab a', 'sid-1');
        const held = await askedCount();
        const lookA = ev(`window.__tab_.showInfoTab().then(() => true)`);
        await waitFor(`window.__reqs.filter(u => /loaded-skills/.test(u)).length > 0 && window.__reqs.length > ${held + 1}`, 'the held skills request'); // A's answer is still on its way
        await live('tab b', ''); await show(); // the tab shown for another agent that gets no sections
        await ev(`window.__releaseSk(); true`); await lookA; await turns();
        assert.equal(await hidden('info-skills'), true, 'A\'s answer arrives after the look for B: no skills row');
        await ev(`window.__gateSk = new Promise(r => { window.__releaseSk = r; }); true`);
        await live('tab a', 'sid-1');
        const held2 = await askedCount();
        const first = ev(`window.__tab_.showInfoTab().then(() => true)`);
        await waitFor(`window.__reqs.length > ${held2 + 1}`, 'the first held request');
        await ev(`window.__sk = { body: { skills: [{ name: 'newer', version: 9, loads: 9, status: 'approved' }] }, status: 200 }; window.__gateSk = null; true`);
        await show(); // the tab shown again: the newest look
        await ev(`window.__releaseSk(); true`); await first; await turns();
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-skills div')].map(d => d.textContent)`), ['newer v9, loaded 9 times'], 'the older look\'s answer does not overwrite the newer');

        console.log('Out-of-order files: the file clicked last is the one shown, whatever order the answers come in; the block names it');
        await ev(`window.__sk = { body: { skills: [] }, status: 200 };
            window.__mem = { body: { files: [{ id: 'a'.repeat(32), file: 'one.md', kind: 'memory', level: 'user' }, { id: 'b'.repeat(32), file: 'two.md', kind: 'memory', level: 'user' }] }, status: 200 };
            window.__files = {}; for (const [c, t] of [['a', 'FIRST file'], ['b', 'SECOND file']]) { const f = { text: t }; f.gate = new Promise(r => { f.release = r; }); window.__files[c.repeat(32)] = f; } true`);
        await live('tab a', 'sid-1'); await show();
        await waitFor(`document.querySelectorAll('#info-memory button').length === 2`, 'two files');
        await ev(`const [b1, b2] = document.querySelectorAll('#info-memory button'); b1.click(); b2.click(); true`);
        await waitFor(`window.__reqs.some(u => u.includes('b'.repeat(32))) && window.__reqs.some(u => u.includes('a'.repeat(32)) && u.includes('/memory/'))`, 'both file requests');
        await ev(`window.__files['b'.repeat(32)].release(); true`); await waitFor(`document.getElementById('info-memory-text').textContent === 'SECOND file'`, 'the second file');
        await ev(`window.__files['a'.repeat(32)].release(); true`); await turns();
        assert.equal(await text('info-memory-text'), 'SECOND file', 'the slower first file does not overwrite the second');
        assert.equal(await ev(`document.getElementById('info-memory-text').dataset.file`), 'two.md: memory, user');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#info-memory button')].map(b => b.getAttribute('aria-pressed'))`), ['false', 'true']);
        await ev(`window.__files = null; true`);

        console.log('The Info button: openInfoTab opens the dock on the Info tab');
        await ev(`document.getElementById('agentic-state').classList.add('collapsed'); window.switchAgenticTab('files', 'top'); window.__infoOpen = import((window.__coralStatic || '/static/') + 'info_tab.js').then(m => m.openInfoTab()); true`);
        await ev(`window.__infoOpen.then(() => true)`);
        await waitFor(`document.getElementById('agentic-panel-info').classList.contains('active') && !document.getElementById('agentic-state').classList.contains('collapsed')`, 'the dock open on Info');

        console.log('Phone: at 390 px with the root text at 100% and at 200% (32 px), in both themes: the files and their text stay inside the panel, nothing runs sideways, a file opens from the keyboard and is read-only');
        await ev(`window.__file = { body: { text: 'Be careful with the memory text.\\nSecond line.' }, status: 200 }; window.__sk = { body: { skills: [{ name: 'release-notes', version: 2, loads: 3, status: 'approved' }] }, status: 200 };
            window.__mem = { body: { files: [{ id: 'a'.repeat(32), file: 'CLAUDE.md', kind: 'instructions', level: 'project' }, { id: 'b'.repeat(32), file: 'notes.md', kind: 'memory', level: 'user' }] }, status: 200 };
            window.__answer = { body: { agent_name: 'tab a', agent_type: 'claude', tmux_session_name: 'tm-1', tmux_command: 'tmux attach -t a-rather-long-session-name-so-the-line-has-to-wrap', working_directory: '/a/very/long/working/directory/that/has/to/wrap/somewhere/on/a/phone', log_path: '/logs/tab-a.log', pane_title: 'tab a pane', git_repo: 'repo', git_branch: 'main', git_commit_hash: '0123456789abcdef', git_commit_subject: 'Fix the thing', prompt: 'You are a helper with a prompt long enough to wrap onto several lines of a narrow screen.' }, status: 200 }; true`);
        await ev(`window.__m.add('tab-bot', 'A', 3, { sleeping: false }); true`);
        await waitFor(`!!window.selectLiveSession`, 'the page\'s live view');
        await ev(`window.selectLiveSession('tab-bot', 'claude', 'sid-1', 'local'); true`); // the agent's page is on screen: the side panel belongs to it
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await ev(`window.toggleAgenticPanel(true); window.switchAgenticTab('info', 'top'); true`); // a phone's side panel is a sheet: open it on the Info tab
        await waitFor(`document.getElementById('agentic-panel-info').getBoundingClientRect().width > 0`, 'the sheet is on screen with the Info panel', 8000);
        for (const rootPx of [null, '32px']) {
            for (const theme of ['light', 'dark']) {
                const tag = `390 px, ${rootPx ? 'text 200% (root ' + rootPx + ')' : 'text 100%'}, ${theme}`;
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(rootPx || '')}; true`);
                await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`); // the earlier cases' toasts are not part of this look
                await show(); await waitFor(`document.querySelectorAll('#info-memory button').length === 2`, `${tag}: two files`);
                await ev(`document.querySelector('#info-memory button').focus(); true`);
                assert.equal(await ev(`document.activeElement === document.querySelector('#info-memory button')`), true, `${tag}: the file button takes the focus (the sheet is open on the Info tab)`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); // a real key event through the browser, not a script click
                await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                await waitFor(`document.getElementById('info-memory-text').textContent.startsWith('Be careful')`, `${tag}: the file text after Enter`);
                await ev(`document.getElementById('info-memory-text').scrollIntoView({ block: 'center' }); true`);
                const m = await ev(`(() => {
                    const panel = document.getElementById('agentic-panel-info'), box = panel.getBoundingClientRect(), vw = window.innerWidth;
                    const inBox = el => { const r = el.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; };
                    const bs = [...document.querySelectorAll('#info-memory button')], pre = document.getElementById('info-memory-text');
                    const fields = ['info-tmux-command', 'info-working-dir', 'info-prompt'].map(id => document.getElementById(id));
                    return { panelW: Math.round(box.width), h: bs.map(b => Math.round(b.getBoundingClientRect().height)), buttonsInBox: bs.every(inBox), textInBox: inBox(pre), fieldsInBox: fields.every(inBox), wide: panel.scrollWidth > panel.clientWidth + 1 || document.documentElement.scrollWidth > vw + 1,
                        pressed: bs.map(b => b.getAttribute('aria-pressed')), file: pre.dataset.file, editable: !!panel.querySelector('input, textarea, [contenteditable]') || pre.isContentEditable, fs: getComputedStyle(document.documentElement).fontSize };
                })()`);
                assert.ok(m.panelW > 0, `${tag}: the panel is on screen: ${JSON.stringify(m)}`);
                assert.ok(m.h.length === 2 && m.h.every(h => h >= 44), `${tag}: both file buttons are 44 px or taller: ${JSON.stringify(m)}`);
                assert.ok(m.buttonsInBox && m.textInBox && m.fieldsInBox, `${tag}: the fields, files and their text stay inside the panel: ${JSON.stringify(m)}`);
                assert.equal(m.wide, false, `${tag}: no sideways scroll: ${JSON.stringify(m)}`);
                assert.deepEqual(m.pressed, ['true', 'false'], `${tag}: Enter opened the first file`); assert.equal(m.file, 'CLAUDE.md: instructions, project');
                assert.equal(m.editable, false, `${tag}: read-only`);
                if (rootPx) assert.equal(m.fs, rootPx, `${tag}: the page really is at 200% text`);
                if (process.env.INFO_TAB_SHOTS) require('node:fs').writeFileSync(`${process.env.INFO_TAB_SHOTS}/info-tab-390-${rootPx ? 'text200' : 'text100'}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); // evidence for a reviewer, not part of the check
            }
        }
        await ev(`document.documentElement.removeAttribute('data-theme'); document.documentElement.style.fontSize = ''; true`);
        await Emulation.clearDeviceMetricsOverride();
        console.log('PASS info tab');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
