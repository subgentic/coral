// Page shortcuts (#10050, the Desktop tester: no way to start a chat without the mouse, and nothing says what keys exist): Alt+N opens New agent, ? lists the shortcuts, the gear menu has "Keyboard shortcuts" for the same list, and the New agent
// buttons carry the key in their hover. A key is ignored in a field or a terminal (a ? typed into the composer stays a ?, Option+N stays a tilde) and with a dialog open. 1280 px, isolated dev server, the harness's stand-in agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { settle } = require('./helpers/wait').bind(ev);
    const key = (k, extra = {}) => Input.dispatchKeyEvent({ type: 'keyDown', key: k, ...extra }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, ...extra }));
    const newAgentOpen = () => ev(`(() => { const d = document.getElementById('launch-step-agent'); return !!d && getComputedStyle(d).display !== 'none' && d.getClientRects().length > 0; })()`);
    const listOpen = () => ev(`(() => { const m = document.getElementById('alert-modal'); return !!m && getComputedStyle(m).display !== 'none' && /Keyboard shortcuts/.test(document.getElementById('alert-modal-title').textContent) ? document.getElementById('alert-modal-message').textContent : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.match(await ev(`document.querySelector('.sidebar-new-btn-full').title`), /Alt\+N/, 'the New agent button says its key');
        // ? in the page lists the shortcuts
        await ev(`document.activeElement && document.activeElement.blur(); true`);
        await key('?', { text: '?', modifiers: 8 }); await settle(300);
        const text = await listOpen();
        assert.ok(text && /Alt\+N\s+New agent/.test(text) && /Show these shortcuts/.test(text), 'the list is shown: ' + JSON.stringify(text));
        await ev(`document.getElementById('alert-modal-ok').click(); true`); await settle(200);
        assert.equal(await listOpen(), null, 'the list closes');
        // ? typed into a field stays a ?
        await ev(`(() => { document.getElementById('agent-search-input').focus(); return document.activeElement.id === 'agent-search-input'; })()`);
        await key('?', { text: '?', modifiers: 8 }); await settle(200);
        assert.equal(await listOpen(), null, 'a ? typed in a field does not open the list');
        // Alt+N is not a key for text entry: not in a field (Option+N is the tilde dead key on a Mac) and not in a terminal (its own meta-n), only from the page
        const altN = async () => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 }); await settle(400); };
        await ev(`document.getElementById('agent-search-input').focus(); true`); await altN();
        assert.equal(await newAgentOpen(), false, 'Alt+N typed in a field does not open New agent');
        await ev(`(() => { const x = document.createElement('div'); x.className = 'xterm'; x.id = 'qa-xterm'; const t = document.createElement('textarea'); x.append(t); document.body.append(x); t.focus(); return document.activeElement === t; })()`); await altN();
        assert.equal(await newAgentOpen(), false, 'Alt+N in a terminal does not open New agent');
        await ev(`document.getElementById('qa-xterm').remove(); true`);
        // #10253 (the desktop tester: a person typing a message cannot reach New agent from the keyboard): the chat's message box is the one field Alt+N works in, where Alt+N is not a typing key (Windows, Linux); on a Mac Option+N is the tilde dead key, so there it is a tilde
        const closeNewAgent = async () => { await ev(`(window.hideLaunchModal || (() => {}))(); true`); await settle(300); };
        const platform = p => ev(`Object.defineProperty(navigator, 'platform', { configurable: true, get: () => ${JSON.stringify(p)} }); try { Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => undefined }); } catch (e) {} true`); // the machine this runs on may be a Mac
        await platform('Linux x86_64');
        await ev(`(() => { const t = document.createElement('textarea'); t.id = 'command-input'; document.body.append(t); t.focus(); return document.activeElement === t; })()`); await altN();
        await waitFor(`(() => { const d = document.getElementById('launch-step-agent'); return !!d && getComputedStyle(d).display !== 'none' && d.getClientRects().length > 0; })()`, 'Alt+N in the message box opens New agent (not a Mac)', { timeout: 6000 });
        await closeNewAgent();
        assert.equal(await newAgentOpen(), false, 'New agent is closed again');
        await platform('MacIntel'); await ev(`document.getElementById('command-input').focus(); true`); await altN();
        assert.equal(await newAgentOpen(), false, 'on a Mac Option+N in the message box stays a tilde: it does not open New agent');
        // the Desktop tester ran on a Mac (#10253 recheck): Ctrl+Option+N is the Mac's key from the message box, and it opens New agent there
        await ev(`document.getElementById('command-input').focus(); true`);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 3 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 3 });
        await waitFor(`(() => { const d = document.getElementById('launch-step-agent'); return !!d && getComputedStyle(d).display !== 'none' && d.getClientRects().length > 0; })()`, 'Ctrl+Option+N in the message box opens New agent on a Mac', { timeout: 6000 });
        await closeNewAgent();
        await platform('Linux x86_64'); await ev(`document.getElementById('command-input').focus(); true`);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 3 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 3 }); await settle(300);
        assert.equal(await newAgentOpen(), false, 'Ctrl+Alt+N is the Mac key: elsewhere it does nothing');
        await platform('MacIntel');
        await ev(`document.getElementById('command-input').remove(); delete navigator.platform; true`);
        // Alt+N opens New agent
        await ev(`document.activeElement && document.activeElement.blur(); true`);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 });
        await waitFor(`(() => { const d = document.getElementById('launch-step-agent'); return !!d && getComputedStyle(d).display !== 'none' && d.getClientRects().length > 0; })()`, 'New agent after Alt+N', { timeout: 6000 });
        assert.equal(await newAgentOpen(), true);
        await ev(`window.hideLaunchModal(); true`); await settle(200);
        // the gear menu has the same list
        await ev(`document.querySelector('[data-on-click="m-toggle-top-bar-settings"]').click(); true`); await settle(300);
        await ev(`document.querySelector('[data-on-click="m-close-top-bar-settings-then-show-shortcuts"]').click(); true`); await settle(300);
        assert.ok(await listOpen(), 'the gear menu opens the list');
        console.log('PASS Alt+N opens New agent, ? and the gear menu list the shortcuts, a field keeps its ?');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
