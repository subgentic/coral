// Jump to and the shortcut list (#10579, Desktop keyboard pass 18:10): Cmd/Ctrl+K opens a box that opens any agent or chat by name (agents from the list, chats from the History search), Up/Down and Enter choose,
// Escape closes it with the focus back; Cmd/Ctrl+, opens Settings; "/" focuses Search agents; Cmd+Option+N is New agent on a Mac, whose list names Cmd and Option; the list has Stop a reply, Search agents and the new keys.
// 1280 px, isolated dev server; the chats search is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    const key = (k, code, modifiers = 0, text) => Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, modifiers, ...(text ? { text } : {}) }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, modifiers }));
    const CTRL = 2, META = 4, ALT = 1;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__opened = [];
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history' && url.searchParams.get('q')) return Promise.resolve(new Response(JSON.stringify({ sessions: !/release/.test(url.searchParams.get('q')) ? [] : [{ session_id: 'chat-0001', title: 'Release notes chat', agent_name: 'Orchestrator' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
                return R(u, o); };
            window.selectHistorySession = id => { window.__opened.push('chat:' + id); return Promise.resolve(); };
            return true; })()`);
        await ev(`window.__m.add('alpha-bot', 'A', 4, { sleeping: false }); window.__m.add('beta-bot', 'B', 4, { sleeping: false }); window.__m.add('lead-bot', 'L', 4, { sleeping: false, board_project: 'team-z' }); true`); await sleep(1000); // sleep-ok: a redraw settles over frames; there is no completion event
        const open = () => ev(`(() => { const m = document.getElementById('jump-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`);
        const names = () => ev(`[...document.querySelectorAll('#jump-list [role=option]')].map(o => o.textContent)`);
        await ev(`document.activeElement && document.activeElement.blur(); true`);

        // Ctrl+K opens the box with the focus in it and the agents under it
        await key('k', 'KeyK', CTRL);
        await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'the jump box', 5000);
        assert.equal(await ev(`document.activeElement.id`), 'jump-input', 'the focus is in the box');
        assert.deepEqual((await names()).sort(), ['alpha-bot', 'beta-bot', 'lead-bot (team-z)'], 'every agent is listed to begin with, with its team when it has one (every team has an Orchestrator)');
        assert.equal(await ev(`document.getElementById('jump-input').getAttribute('role')`), 'combobox');
        // nothing matches: Enter and a click on the blank list leave the box open, and nothing is pointed at
        await Input.insertText({ text: 'zzzqq' }); await sleep(600); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.deepEqual(await names(), [], 'no match');
        assert.equal(await ev(`document.getElementById('jump-input').hasAttribute('aria-activedescendant')`), false, 'nothing is pointed at when nothing matches');
        await key('Enter', 'Enter', 0, '\r'); await sleep(200); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await open(), true, 'Enter with no match does not close the box');
        await ev(`document.getElementById('jump-list').click(); true`); await sleep(200); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await open(), true, 'a click on the blank list does not close it');
        await ev(`document.getElementById('jump-input').value = ''; true`);
        // typing narrows it, and the chats of the History search join the agents
        await Input.insertText({ text: 'beta' }); await sleep(500); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal((await names())[0], 'beta-bot', 'the agent that matches is first');
        await ev(`document.getElementById('jump-input').value = ''; true`);
        await Input.insertText({ text: 'release' }); await waitFor(`[...document.querySelectorAll('#jump-list [role=option]')].some(e => e.textContent === 'Release notes chat (chat)')`, 'the chat match', 5000);
        // a chat by Down and Enter
        await key('ArrowDown', 'ArrowDown'); await key('Enter', 'Enter', 0, '\r');
        await waitFor(`window.__opened.includes('chat:chat-0001')`, 'the chat is opened', 5000);
        assert.equal(await open(), false, 'the box closes when one is chosen');
        // an agent by Enter
        await key('k', 'KeyK', META); await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'the box again (Cmd+K)', 5000);
        await Input.insertText({ text: 'beta' }); await sleep(500); await key('Enter', 'Enter', 0, '\r'); // sleep-ok: a redraw settles over frames; there is no completion event
        await waitFor(`(window.T && T.state.currentSession && T.state.currentSession.name === 'beta-bot') || document.querySelector('#live-session-view [data-session-name="beta-bot"]')`, 'beta-bot is open', 8000).catch(async () => { throw new Error('beta-bot not opened: ' + await ev(`JSON.stringify(window.T && T.state.currentSession && T.state.currentSession.name)`)); });
        assert.equal(await open(), false, 'the box is closed');
        // Escape closes the box and gives the focus back
        await ev(`document.getElementById('agent-search-input').focus(); true`);
        await key('k', 'KeyK', CTRL); await waitFor(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`, 'the box', 5000);
        await key('Escape', 'Escape'); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await open(), false, 'Escape closes it');
        assert.equal(await ev(`document.activeElement.id`), 'agent-search-input', 'and the focus goes back where it was');

        // Ctrl+, is Settings
        await ev(`document.activeElement && document.activeElement.blur(); true`);
        await key(',', 'Comma', CTRL);
        await waitFor(`(() => { const m = document.getElementById('settings-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, 'Settings opens', 8000);
        await key('Escape', 'Escape'); await sleep(300); // sleep-ok: a redraw settles over frames; there is no completion event

        // / is Search agents
        await ev(`document.activeElement && document.activeElement.blur(); true`);
        await key('/', 'Slash', 0, '/'); await sleep(200); // sleep-ok: a redraw settles over frames; there is no completion event
        assert.equal(await ev(`document.activeElement.id`), 'agent-search-input', '/ focuses Search agents');
        assert.equal(await ev(`document.getElementById('agent-search-input').value`), '', 'and types nothing into it');

        // the list: Stop a reply, Search agents and the new keys, in the person's own words
        const lists = await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => ({ mac: m.shortcutList(true).map(r => r[0] + ' ' + r[1]), pc: m.shortcutList(false).map(r => r[0] + ' ' + r[1]) }))`);
        const has = (l, re) => l.some(x => re.test(x));
        assert.ok(has(lists.mac, /^Cmd\+Option\+N New agent/) && !has(lists.mac, /Alt\+N|Ctrl\+K|Ctrl\+F/), `a Mac sees Cmd and Option: ${JSON.stringify(lists.mac)}`);
        assert.ok(has(lists.pc, /^Alt\+N New agent/) && has(lists.pc, /^Ctrl\+K Jump to/) && has(lists.pc, /^Ctrl\+, Settings/), `another computer sees Ctrl and Alt: ${JSON.stringify(lists.pc)}`);
        for (const l of [lists.mac, lists.pc]) assert.ok(has(l, /Search agents/) && has(l, /Stop a reply/), 'the list has Search agents and Stop a reply');

        // Cmd+Option+N is New agent on a Mac
        await ev(`Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' }); document.activeElement && document.activeElement.blur(); true`);
        await key('n', 'KeyN', META | ALT);
        await waitFor(`(() => { const d = document.getElementById('launch-step-agent'); return !!d && getComputedStyle(d).display !== 'none' && d.getClientRects().length > 0; })()`, 'New agent opens with Cmd+Option+N', 8000);
        console.log('PASS Jump to (Cmd/Ctrl+K) opens agents and chats by name; Cmd/Ctrl+, Settings; / Search agents; the list in the person\'s own keys');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
