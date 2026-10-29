// A Codex approval request is alerted only once it has stood (#7420). Codex's own reviewer (approvals_reviewer = "auto_review") settles a command approval about two seconds after the
// PermissionRequest hook fires, with no dialog and nobody to ask; the "needs your input" toast for it was a false alarm, repeated for every coral-board command of a notice-driven loop. The
// hook sequence is permission_request, tool_use, stop, so the row clears by itself: a request that is gone before the hold is never alerted, one still open after it is, and every other
// request (another CLI's, a Codex login or startup prompt) is alerted at once as before.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the hold is a wall-clock wait in the page; what is asserted is that nothing appeared by then
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('cx', 'C', 6, { sleeping: false, agent_type: 'codex' }); window.__m.add('cl', 'L', 6, { sleeping: false, agent_type: 'claude' }); window.__m.add('cx2', 'D', 6, { sleeping: false, agent_type: 'codex' }); true`);
        const HOLD = await ev(`import(${MOD} + 'websocket.js').then(m => m.CODEX_REVIEW_HOLD_MS)`);
        assert.ok(HOLD >= 2000 && HOLD <= 8000, `the hold is a few seconds: ${HOLD}`);
        // waiting: { name: { kind, since } } for the rows that wait; every other row is idle.
        const feed = (waiting) => ev(`(async () => {
            const ws = await import(${MOD} + 'websocket.js'); const { state } = await import(${MOD} + 'state.js');
            const w = ${JSON.stringify(waiting)};
            const rows = Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), waiting_for_input: !!w[a.name], waiting_kind: w[a.name] ? w[a.name].kind : null, waiting_since: w[a.name] ? w[a.name].since : null }));
            state.settings = state.settings || {}; ws.handleCoralMessage({ type: 'coral_update', sessions: rows, servers: [] }); return true; })()`);
        const toasts = () => ev(`document.querySelectorAll('.notification-toast').length`);
        const clear = () => ev(`document.querySelectorAll('.notification-toast').forEach(t => t.remove()); true`);
        await ev(`import(${MOD} + 'websocket.js').then(m => { m._resetWaitingSeedForTests(); return true; })`);
        await feed({});

        // 1. A Claude permission request is alerted at once (its hook is the person's dialog).
        await feed({ cl: { kind: 'permission', since: 't1' } });
        await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'the Claude request toasts at once', { timeout: 2000 });
        await feed({}); await clear();

        // 2. A Codex login or startup prompt, or an elicitation, is alerted at once too.
        for (const kind of ['login', 'startup', 'elicitation']) {
            await feed({ cx: { kind, since: 't2' } });
            await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, `a Codex ${kind} request toasts at once`, { timeout: 2000 });
            await feed({}); await clear();
        }

        // 3. A Codex approval the reviewer settles: it rises, the tool runs (the row clears) inside the hold. No toast, then or later.
        await feed({ cx: { kind: 'permission', since: 't3' } });
        assert.equal(await toasts(), 0, 'no toast the moment a Codex approval request rises');
        await sleep(Math.min(1000, HOLD / 4)); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        await feed({});
        await sleep(HOLD + 600); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 0, 'a request gone inside the hold is never alerted');

        // 4. The same, again and again (a notice-driven loop of coral-board reads): still nothing.
        for (let i = 0; i < 3; i++) {
            await feed({ cx: { kind: 'permission', since: 'loop' + i } });
            await sleep(300); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
            await feed({});
            await sleep(100); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        }
        await sleep(HOLD + 600); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 0, 'repeated settled requests raise nothing');

        // 5. A request that is still open after the hold is alerted, once.
        await feed({ cx: { kind: 'permission', since: 't5' } });
        assert.equal(await toasts(), 0, 'not at once');
        await sleep(HOLD - 1500); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 0, 'not before the hold is over');
        await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'a request still open after the hold toasts', { timeout: 6000 });
        await feed({ cx: { kind: 'permission', since: 't5' } }); // a repeated tick in the same state
        await sleep(300); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 1, 'once, not again on the next tick');
        await feed({}); await clear();

        // 6. One request settled and another opened inside the hold: the first one's timer must not alert for the second early, and the second alerts once, after its own hold.
        await feed({ cx: { kind: 'permission', since: 'a' } });
        await sleep(HOLD - 1500); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        await feed({});
        await feed({ cx: { kind: 'permission', since: 'b' } });
        await sleep(1800); // the first request's hold is over now; the second's is not // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 0, 'the first request\'s timer says nothing of the second');
        await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'the second request alerts after its own hold', { timeout: 6000 });
        await feed({}); await clear();

        // 7. A Codex row that waits from two agents is held per agent: both alert, each once.
        await feed({ cx: { kind: 'permission', since: 'x' }, cx2: { kind: 'permission', since: 'y' } });
        await waitFor(`document.querySelectorAll('.notification-toast').length === 2`, 'each held agent alerts', { timeout: HOLD + 4000 });
        await sleep(300); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is that nothing appears while it runs
        assert.equal(await toasts(), 2);
        console.log('PASS a Codex approval request is alerted only after it has stood; a request the reviewer settles, and any other CLI\'s or kind, behave as specified');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
