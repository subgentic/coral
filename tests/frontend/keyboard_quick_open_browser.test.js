// More shortcuts, the ones people know from VS Code and GoLand (#10677, the operator): Cmd/Ctrl+P or K is Jump to (agents, chats, teams, goals), Cmd/Ctrl+Shift+P or F1 the command list, Cmd/Ctrl+B the sidebar, Cmd/Ctrl+Shift+F
// Search all chats, Ctrl+` the agent's terminal and back, Alt/Option+Down and Up the next and previous agent, with Shift the team. Cmd on a Mac and Ctrl elsewhere (not a Mac's Ctrl+P, B, F, K: its text-cursor keys); never in a
// text box (the arrows) or a dialog; the list names them in the person's own words. 1280 px, isolated dev server; goals and chats are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    const CTRL = 2, META = 4, ALT = 1, SHIFT = 8;
    const key = (k, code, modifiers = 0, text) => Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, modifiers, ...(text ? { text } : {}) }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, modifiers }));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const mac = await ev(`/Mac/i.test(navigator.platform)`), MOD = mac ? META : CTRL, OTHER = mac ? CTRL : META;
        await ev(`(() => { const R = window.fetch; window.__team = []; window.openTeamPage = (k, o) => { window.__team.push([k, o]); return Promise.resolve(); };
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/goals') return Promise.resolve(new Response(JSON.stringify({ goals: [{ id: 7, board_id: 'team-z', title: 'Ship the release', state: 'active' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
                return R(u, o); };
            return true; })()`);
        await ev(`window.__m.add('alpha-bot', 'A', 4, { sleeping: false }); window.__m.add('lead-bot', 'L', 4, { sleeping: false, board_project: 'team-z' }); window.__m.add('ops-bot', 'O', 4, { sleeping: false, board_project: 'team-y' }); true`); await sleep(1000); // sleep-ok: a redraw settles over frames; there is no completion event
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        const shown = () => ev(`(() => { const m = document.getElementById('jump-modal'); return !!m && getComputedStyle(m).display !== 'none' ? { title: document.getElementById('jump-title').textContent, options: [...document.querySelectorAll('#jump-list [role=option]')].map(o => o.textContent) } : null; })()`);
        const closeBox = async () => { await key('Escape', 'Escape'); await sleep(250); }; // sleep-ok: a redraw settles over frames; there is no completion event
        const blur = () => ev(`document.activeElement && document.activeElement.blur(); true`);

        // Jump to: Cmd/Ctrl+P, finds a goal and a team by name; the other modifier does nothing
        await blur(); await key('p', 'KeyP', OTHER); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await shown(), null, `${mac ? 'Ctrl' : 'Cmd'}+P is not the key on this computer`);
        await key('p', 'KeyP', MOD);
        await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'Jump to', 5000);
        assert.equal((await shown()).title, 'Jump to');
        await Input.insertText({ text: 'release' }); await sleep(600); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.ok((await shown()).options.includes('Ship the release (goal)'), 'a goal is found by name: ' + JSON.stringify(await shown()));
        await key('Enter', 'Enter', 0, '\r'); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.deepEqual(await ev(`window.__team.pop()`), ['team-z', { tab: 'goals', item: 7 }], 'the goal opens on its team page');
        await key('k', 'KeyK', MOD); await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'Jump to by K', 5000);
        await Input.insertText({ text: 'team-y' }); await sleep(500); // sleep-ok: a redraw settles over frames; there is no completion event
        const opts = (await shown()).options, at = opts.indexOf('team-y (team)');
        assert.ok(at >= 0, 'a team is found by name: ' + JSON.stringify(opts));
        for (let i = 0; i < at; i++) await key('ArrowDown', 'ArrowDown');
        await key('Enter', 'Enter', 0, '\r'); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal((await ev(`window.__team.pop()`))[0], 'team-y', 'the team opens');

        // the command list: Cmd/Ctrl+Shift+P and F1
        await blur(); await key('p', 'KeyP', MOD | SHIFT);
        await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'the command list', 5000);
        let box = await shown();
        assert.equal(box.title, 'Commands');
        for (const c of ['Settings', 'New agent', 'New project', 'Go to Inbox', 'Go to Agents', 'Go to Automations', 'Show or hide the sidebar', 'Search all chats']) assert.ok(box.options.includes(c), `the command list has ${c}: ${JSON.stringify(box.options)}`);
        await Input.insertText({ text: 'automations' }); await sleep(400); // sleep-ok: a redraw settles over frames; there is no completion event
        await key('Enter', 'Enter', 0, '\r'); await sleep(500); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`), 'automations', 'a command runs');
        await ev(`window.switchNavTab('agents'); true`); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        await blur(); await key('F1', 'F1');
        await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'the command list by F1', 5000);
        assert.equal((await shown()).title, 'Commands'); await closeBox();

        // the sidebar
        const collapsed = () => ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`);
        const before = await collapsed();
        await blur(); await key('b', 'KeyB', MOD); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await collapsed(), !before, 'the sidebar folds and opens');
        await key('b', 'KeyB', MOD); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await collapsed(), before);

        // next and previous agent and team (Alt/Option+Down and Up)
        await ev(`window.selectLiveSession('alpha-bot', 'claude', 'alpha-bot-id', 'local'); true`); await sleep(800); // sleep-ok: a redraw settles over frames; there is no completion event
        const current = () => ev(`(() => { const r = document.querySelector('.session-group-item[aria-current="true"]'); return r && r.dataset.name; })()`);
        const first = await current();
        await blur(); await key('ArrowDown', 'ArrowDown', ALT); await sleep(600); // sleep-ok: a redraw settles over frames; there is no completion event
        const second = await current();
        assert.notEqual(second, first, `Alt/Option+Down is the next agent (${first} to ${second})`);
        await key('ArrowUp', 'ArrowUp', ALT); await sleep(600); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await current(), first, 'and Up the previous');
        await ev(`document.getElementById('agent-search-input').focus(); true`);
        await key('ArrowDown', 'ArrowDown', ALT); await sleep(400); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await current(), first, 'in a text box the arrows are the box\'s');
        await blur(); await ev(`window.__team.length = 0; true`);
        await key('ArrowDown', 'ArrowDown', ALT | SHIFT); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal((await ev(`window.__team`)).length, 1, 'Alt/Option+Shift+Down opens the next team: ' + JSON.stringify(await ev(`window.__team`)));

        // the agent's terminal and back (Ctrl+`, on every computer), where the agent has one
        if (await ev(`(() => { const b = document.getElementById('live-view-btn-terminal'); return !!b && b.getClientRects().length > 0; })()`)) {
            await key('`', 'Backquote', CTRL); await sleep(500); // sleep-ok: a redraw settles over frames; there is no completion event
            assert.equal(await ev(`document.getElementById('live-view-btn-terminal').classList.contains('active')`), true, 'Ctrl+` shows the terminal');
            await key('`', 'Backquote', CTRL); await sleep(500); // sleep-ok: a redraw settles over frames; there is no completion event
            assert.equal(await ev(`document.getElementById('live-view-btn-chat').classList.contains('active')`), true, 'and again the chat');
        }

        // on another computer than a Mac the keys are Ctrl and Alt: Cmd does nothing, Ctrl+P opens Jump to
        await ev(`Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({ platform: 'Windows' }) }); true`);
        await blur(); await key('p', 'KeyP', META); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await shown(), null, 'Cmd+P is not a key there');
        await key('p', 'KeyP', CTRL);
        await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'Ctrl+P opens Jump to', 5000);
        await closeBox();
        await ev(`delete navigator.userAgentData; delete navigator.platform; true`); // the browser's own answer again

        // Search all chats
        await blur(); await key('f', 'KeyF', MOD | SHIFT);
        await waitFor(`document.body.getAttribute('data-nav-tab') === 'hub-inbox'`, 'the Inbox opens', 8000);

        // the list, in the person's own words
        const lists = await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => ({ mac: m.shortcutList(true).map(r => r[0] + ' ' + r[1]), pc: m.shortcutList(false).map(r => r[0] + ' ' + r[1]) }))`);
        const has = (l, re) => l.some(x => re.test(x));
        for (const re of [/^Cmd\+P or Cmd\+K Jump to an agent, chat, team or goal/, /^Cmd\+Shift\+P or F1 The command list/, /^Cmd\+B /, /^Cmd\+Shift\+F Search all chats/, /^Option\+Down or Up Next or previous agent/, /^Option\+Shift\+Down or Up Next or previous team/, /^Ctrl\+` /]) assert.ok(has(lists.mac, re), `a Mac's list has ${re}: ${JSON.stringify(lists.mac)}`);
        for (const re of [/^Ctrl\+P or Ctrl\+K /, /^Ctrl\+Shift\+P or F1 /, /^Ctrl\+B /, /^Ctrl\+Shift\+F /, /^Alt\+Down or Up /, /^Alt\+Shift\+Down or Up /, /^Ctrl\+` /]) assert.ok(has(lists.pc, re), `another computer's list has ${re}: ${JSON.stringify(lists.pc)}`);
        console.log('PASS Quick open and the command list: P/K, Shift+P/F1, B, Shift+F, Alt+Up/Down, Ctrl+`, the list in Cmd and Option or Ctrl and Alt');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
