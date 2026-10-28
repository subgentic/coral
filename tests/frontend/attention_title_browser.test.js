// A hidden tab tells the person that an agent replied or needs them (#10068, desktop pass #10063): a count in the tab title ("(1) Coral"), cleared on return, and with the browser's
// opt-in a desktop alert per kind. A visible tab changes nothing. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('alpha', 'A', 6, { sleeping: false }); window.__m.add('beta', 'B', 6, { sleeping: false }); true`);
        // The browser opted in to desktop alerts; the page can be made hidden by the test.
        await ev(`(() => { window.__notes = []; function N(t, o) { this.title = t; this.opts = o; window.__notes.push(this); this.close = () => {}; } N.permission = 'granted'; window.Notification = N;
            localStorage.setItem('coral-desktop-notify', '1'); window.__hidden = false;
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden }); return true; })()`);
        await ev(`import(${MOD} + 'websocket.js').then(m => { m._resetWaitingSeedForTests(); return true; })`);
        // One feed message with each agent's state: 'working', 'replied' (the turn ended: it awaits its person), 'needs' or 'idle'.
        const feed = (states) => ev(`(async () => {
            const ws = await import(${MOD} + 'websocket.js'); const { state } = await import(${MOD} + 'state.js');
            const S = ${JSON.stringify(states)};
            const rows = Object.values(window.__m.agents).map(a => { const k = S[a.name] || 'idle';
                return { ...window.__m.entry(a), working: k === 'working', waiting_for_input: k === 'needs', awaiting_user: k === 'replied', done: k === 'replied' }; });
            state.settings = state.settings || {}; ws.handleCoralMessage({ type: 'coral_update', sessions: rows, servers: [] }); return true; })()`);
        const title = () => ev(`document.title`);
        const resetAlertGap = () => ev(`import(${MOD} + 'desktop_notify.js').then(m => { m._resetRateForTests(); return true; })`);

        // The first message only records who is in which state.
        await feed({ alpha: 'working', beta: 'idle' });
        assert.equal(await title(), 'Coral', 'nothing yet');

        // A visible tab: the reply changes nothing (the page's own rows show it).
        await feed({ alpha: 'replied', beta: 'idle' });
        assert.equal(await title(), 'Coral', 'a visible tab keeps its title');
        assert.equal(await ev(`window.__notes.length`), 0, 'and raises no alert');

        // A hidden tab: alpha's next turn ends.
        await ev(`window.__hidden = true; true`);
        await feed({ alpha: 'working', beta: 'idle' });
        await feed({ alpha: 'replied', beta: 'idle' });
        await waitFor(`document.title === '(1) Coral'`, 'the reply counted in the tab title');
        await waitFor(`window.__notes.length === 1`, 'the reply alert');
        assert.equal(await ev(`window.__notes[0].opts.body`), 'alpha finished a reply', 'names only, and what happened');
        assert.equal(await ev(`window.__notes[0].opts.silent`), true, 'no sound unless turned on');

        // Another agent needs the person: the count grows and the alert says so.
        await feed({ alpha: 'replied', beta: 'needs' });
        await waitFor(`document.title === '(2) Coral'`, 'the request counted too');
        await waitFor(`window.__notes.length === 2`, 'the needs-input alert');
        assert.equal(await ev(`window.__notes[1].opts.body`), 'beta needs input');

        // The person comes back: the count goes.
        await ev(`window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); true`);
        await waitFor(`document.title === 'Coral'`, 'the title cleared on return');

        // Reply alerts can be turned off on their own; the title still counts.
        await resetAlertGap();
        await ev(`localStorage.setItem('coral-alert-finished', '0'); window.__notes.length = 0; window.__hidden = true; true`);
        await feed({ alpha: 'working', beta: 'idle' });
        await feed({ alpha: 'replied', beta: 'idle' });
        await waitFor(`document.title === '(1) Coral'`, 'the count without an alert');
        assert.equal(await ev(`window.__notes.length`), 0, 'replies off: no alert');
        await ev(`window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); true`);
        console.log('PASS a hidden tab counts replies and requests in its title and alerts per kind; a visible tab changes nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
