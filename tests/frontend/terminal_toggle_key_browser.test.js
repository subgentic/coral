// Ctrl+` goes back to the chat from a focused terminal too (#10749, QA Reviewer 2 on #10677): the shortcut list says "the agent's terminal, and back to its chat", but a key typed in the terminal never reached the
// page's shortcuts (a terminal keeps its keys), so the way back needed the mouse. Now Ctrl+` from the terminal takes the page's toggle, sends nothing to the agent, and the chat's message box gets the focus; every other page
// shortcut (Ctrl+P, Ctrl+B) is still the terminal's own key there, and a plain ` is typed. The terminal is the real xterm on a fake socket (terminal_leave_key_browser's setup); the view buttons are stand-ins that count clicks.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`); // the whole app: the page's shortcuts are wired at its start
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const T = window.T = { state: (await import(st + 'state.js')).state, x: await import(st + 'xterm_renderer.js') };
            await (await import(st + 'vendor_loader.js')).loadXterm();
            window.__sent = []; window.__sockets = [];
            class FakeWS { constructor(u) { this.url = String(u); this.readyState = 0; window.__sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen && this.onopen({}); } }, 5); }
                send(d) { window.__sent.push(String(d)); } close() { this.readyState = 3; } addEventListener() {} removeEventListener() {} }
            FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
            const RealWS = window.WebSocket; window.WebSocket = function (u, p) { return /\\/ws\\/terminal\\//.test(String(u)) ? new FakeWS(u) : (p === undefined ? new RealWS(u) : new RealWS(u, p)); };
            Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); window.WebSocket.prototype = RealWS.prototype;
            const host = document.createElement('div'); host.id = 'qa-term-host'; host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:400px;z-index:99999;background:#000'; document.body.appendChild(host); window.__host = host;
            // stand-ins for the agent view's two buttons and the chat's box: the terminal view is the one showing
            window.__clicks = [];
            const mk = (id, cls) => { const b = document.createElement('button'); b.id = id; b.className = cls; b.style.cssText = 'position:fixed;right:0;top:0;width:10px;height:10px'; b.addEventListener('click', () => { window.__clicks.push(id); document.getElementById('live-view-btn-terminal').classList.toggle('active', id === 'live-view-btn-terminal'); document.getElementById('live-view-btn-chat').classList.toggle('active', id === 'live-view-btn-chat'); }); document.body.appendChild(b); return b; };
            for (const id of ['live-view-btn-terminal', 'live-view-btn-chat']) document.getElementById(id)?.remove(); // the page's own buttons are hidden here: these stand in for them
            mk('live-view-btn-terminal', 'active'); mk('live-view-btn-chat', '');
            document.getElementById('command-input')?.remove(); { const t = document.createElement('textarea'); t.id = 'command-input'; t.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:30px'; document.body.appendChild(t); } // the chat's box, shown as it is once the chat view is
            T.state.currentSession = { name: 't1', type: 'live', session_id: 'sess-t1', agent_type: 'claude' };
            window.__term = T.x.createTerminal(host); T.x.connectTerminalWs('t1', 'claude', 'sess-t1', 'local');
            return true; })()`);
        const sleep = ms => ev(`new Promise(r => setTimeout(r, ${ms}))`); // sleep-ok: the socket opens and the typed text is batched over a few ms
        await sleep(120); // sleep-ok: the fake socket opens after a few ms
        const key = init => ev(`window.__term.focus(); window.__sent.length = 0; window.__clicks.length = 0; window.__term.textarea.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}))); true`);
        const sentData = () => ev(`window.__sent.map(m => JSON.parse(m).data || '').join('')`);

        await key({ key: '`', code: 'Backquote', keyCode: 192, ctrlKey: true }); await sleep(80);
        check(JSON.stringify(await ev(`window.__clicks`)) === '["live-view-btn-chat"]', 'Ctrl+` from the focused terminal goes back to the chat: ' + JSON.stringify(await ev(`window.__clicks`)));
        check((await sentData()) === '', 'and sends nothing to the agent: ' + JSON.stringify(await sentData()));
        check(await ev(`document.activeElement && document.activeElement.id === 'command-input'`), 'and the chat\'s message box has the focus');

        // the other page shortcuts are still the terminal's own keys there
        await ev(`document.getElementById('live-view-btn-terminal').click(); true`);
        await key({ key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true }); await sleep(80);
        check((await sentData()).includes('\x10'), 'Ctrl+P is still typed to the agent (a shell\'s previous line): ' + JSON.stringify(await sentData()));
        check(!(await ev(`!!document.getElementById('jump-modal') && getComputedStyle(document.getElementById('jump-modal')).display !== 'none'`)), 'and does not open Jump to from the terminal');
        check(JSON.stringify(await ev(`window.__clicks`)) === '[]', 'and the view does not change');
        await key({ key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true }); await sleep(80);
        check((await sentData()).includes('\x02'), 'Ctrl+B is still typed to the agent (tmux\'s prefix): ' + JSON.stringify(await sentData()));

        // a plain ` is typed, and Ctrl+Shift+` is not the shortcut
        await key({ key: '`', code: 'Backquote', keyCode: 192 }); await sleep(80);
        check(JSON.stringify(await ev(`window.__clicks`)) === '[]', 'a plain ` does not change the view');
        await key({ key: '~', code: 'Backquote', keyCode: 192, ctrlKey: true, shiftKey: true }); await sleep(80);
        check(JSON.stringify(await ev(`window.__clicks`)) === '[]', 'Ctrl+Shift+` is not the shortcut');

        // the list says it works from the terminal
        const row = await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => m.shortcutList().find(r => r[0] === 'Ctrl+\`'))`);
        check(row && /from the terminal too/.test(row[1]), 'the shortcut list says Ctrl+` works from the terminal: ' + JSON.stringify(row));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Ctrl+` from the terminal:\n  ' + problems.join('\n  '));
    console.log('PASS Ctrl+` goes back to the chat from a focused terminal');
})().catch(e => { console.error(e); process.exit(1); });
