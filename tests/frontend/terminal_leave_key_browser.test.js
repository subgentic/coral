// The terminal's way out for the keyboard works on every OS (#10345, QA Reviewer 2 on #10247): Ctrl+Shift+Escape is Windows' Task Manager and never reaches the page, so a keyboard user on Windows was shut in. Ctrl+] (the
// telnet escape, never typed in a shell) lets go of the terminal too, and sends nothing to the agent; Ctrl+Shift+Escape still does where it arrives; a plain ] is typed; and the words that say how to leave name the key for the
// person's OS (Ctrl+] on Windows, both elsewhere), in the status bar's hint and in what a screen reader is told when Open terminal puts the keyboard in. Drives Chrome over CDP through agent_view_harness.js; the terminal is
// the real xterm on a fake socket (the golden suite's setup).
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
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
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
            T.state.currentSession = { name: 't1', type: 'live', session_id: 'sess-t1', agent_type: 'claude' };
            window.__term = T.x.createTerminal(host); T.x.connectTerminalWs('t1', 'claude', 'sess-t1', 'local');
            return true; })()`);
        const sleep = ms => ev(`new Promise(r => setTimeout(r, ${ms}))`); // sleep-ok: the socket opens and the typed text is batched over a few ms
        await sleep(120); // sleep-ok: the fake socket opens after a few ms
        const focused = () => ev(`window.__host.classList.contains('xterm-focused')`);
        const key = init => ev(`window.__term.focus(); window.__sent.length = 0; window.__term.textarea.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}))); true`);
        await key({ key: ']', code: 'BracketRight', ctrlKey: true }); await sleep(60);
        check(!(await focused()), 'Ctrl+] lets go of the terminal');
        check(!(await ev(`window.__sent.join('').includes('\\x1d')`)), 'and sends nothing to the agent (no GS character)');
        await key({ key: 'Escape', code: 'Escape', ctrlKey: true, shiftKey: true }); await sleep(60);
        check(!(await focused()), 'Ctrl+Shift+Escape still lets go where it arrives');
        await ev(`window.__term.focus(); true`); await key({ key: ']', code: 'BracketRight' }); await sleep(60);
        check(await focused(), 'a plain ] does not let go');
        // the words
        const words = await ev(`import((window.__coralStatic || '/static/') + 'terminal_leave_key.js').then(m => [m.leaveKeyWords(true), m.leaveKeyWords(false)])`).catch(e => ['missing: ' + e.message, '']);
        check(words[0] === 'Ctrl+]', `on Windows the words name Ctrl+] only: ${JSON.stringify(words[0])}`);
        check(/Ctrl\+Shift\+Escape/.test(words[1]) && /Ctrl\+\]/.test(words[1]), `elsewhere they name both: ${JSON.stringify(words[1])}`);
        const hint = await ev(`(document.getElementById('xterm-focus-hint') || {}).textContent || ''`);
        check(/Ctrl\+\]/.test(hint), `the status bar's hint names Ctrl+]: ${JSON.stringify(hint)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the terminal leave key:\n  ' + problems.join('\n  '));
    console.log('PASS the terminal can be left with Ctrl+] on every OS, and the words name the key');
})().catch(e => { console.error(e); process.exit(1); });
