// The terminal view reports to the server whether it is focused (type terminal_focus, goal #14: the dialog timeout counts a focused view as a person at the agent). Two rules:
// (1) a visible but INACTIVE window (the textarea is still the page's activeElement, document.hasFocus() is false) is not "focused", and a blur or focus of the window re-reports;
// (2) the 60 s re-report timer stops when the socket is disconnected or the terminal disposed, and a reconnect starts it again.
// Drives Chrome over CDP through agent_view_harness.js; the socket is a fake. The window's focus is stood in (document.hasFocus and the window's own blur and focus events), so the person's real focus is never taken.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Emulation.setFocusEmulationEnabled({ enabled: true }); // the page counts as the focused window of its own browser, whatever the machine's focus is
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const T = window.T = { state: (await import(st + 'state.js')).state, x: await import(st + 'xterm_renderer.js') };
            await (await import(st + 'vendor_loader.js')).loadXterm();
            window.__sent = []; window.__sockets = [];
            class FakeWS { constructor(u) { this.url = String(u); this.readyState = 0; window.__sockets.push(this); this.closed = false;
                    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen && this.onopen({}); } }, 5); }
                send(d) { window.__sent.push(String(d)); } close() { this.closed = true; this.readyState = 3; }
                addEventListener() {} removeEventListener() {} }
            FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
            const RealWS = window.WebSocket; window.WebSocket = function (u, p) { return /\\/ws\\/terminal\\//.test(String(u)) ? new FakeWS(u) : (p === undefined ? new RealWS(u) : new RealWS(u, p)); };
            Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); window.WebSocket.prototype = RealWS.prototype;
            // the 60 s re-report timer is seen through setInterval and clearInterval
            window.__ivs = []; const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
            window.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); if (ms === 60000) window.__ivs.push({ id, cleared: false }); return id; };
            window.clearInterval = id => { for (const r of window.__ivs) if (r.id === id) r.cleared = true; return ci(id); };
            let host = document.getElementById('qa-term-host'); if (!host) { host = document.createElement('div'); host.id = 'qa-term-host'; host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:400px;z-index:99999;background:#000'; document.body.appendChild(host); }
            window.__host = host;
            T.state.currentSession = { name: 't1', type: 'live', session_id: 'sess-t1', agent_type: 'claude' };
            return typeof Terminal !== 'undefined'; })()`);
        assert.equal(await ev(`typeof Terminal !== 'undefined'`), true, 'xterm is loaded');
        const sleep = ms => ev(`new Promise(r => setTimeout(r, ${ms}))`); // sleep-ok: the fake socket opens and the focus reports land over a few ms; there is no completion event
        const reports = () => ev(`window.__sent.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(m => m && m.type === 'terminal_focus').map(m => m.focused)`);
        const last = async () => { const r = await reports(); return r[r.length - 1]; };
        const live = () => ev(`window.__ivs.filter(r => !r.cleared).length`);

        await ev(`window.__term = T.x.createTerminal(window.__host); true`);
        await ev(`T.x.connectTerminalWs('t1', 'claude', 'sess-t1', 'local'); true`); await sleep(80);
        await ev(`window.__host.querySelector('textarea').focus(); true`); await sleep(60);
        check('a focused view in an active window reports focused', (await last()) === true, JSON.stringify(await reports()));
        check('and the 60 s timer runs', (await live()) === 1, String(await live()));

        // (1) the window goes inactive while the textarea is still the active element: not focused, and it is reported at once
        await ev(`window.__hasFocusReal = document.hasFocus; document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); true`); await sleep(40);
        check('an inactive window (hasFocus false) reports not focused', (await last()) === false, JSON.stringify(await reports()));
        check('and its timer stops', (await live()) === 0, String(await live()));
        await ev(`document.hasFocus = window.__hasFocusReal; window.dispatchEvent(new Event('focus')); true`); await sleep(40);
        check('the window regained: focused again', (await last()) === true, JSON.stringify(await reports()));
        check('and the timer runs again', (await live()) === 1, String(await live()));

        // (2) disconnect clears the timer, a reconnect starts it, dispose clears it
        await ev(`T.x.disconnectTerminalWs(); true`); await sleep(40);
        check('a disconnected view has no timer', (await live()) === 0, String(await live()));
        await ev(`window.__sent.length = 0; T.x.connectTerminalWs('t1', 'claude', 'sess-t1', 'local'); true`); await sleep(80);
        check('a reconnect of a focused view reports focused on the new socket', (await last()) === true, JSON.stringify(await reports()));
        check('and its timer runs', (await live()) === 1, String(await live()));
        await ev(`T.x.disposeTerminal(); true`); await sleep(40);
        check('a disposed terminal has no timer', (await live()) === 0, String(await live()));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} terminal focus report checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
