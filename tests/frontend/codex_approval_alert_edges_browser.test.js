// Edges of the held Codex approval alert (#7420), by QA for the review: a request that turns into another kind inside the hold alerts once (not twice), a row that goes away inside the hold alerts nobody and breaks
// nothing, the same open request fed again by every update alerts once, a second request after an alert alerts again after its own hold. Same page-level harness as codex_approval_alert_browser (rows fed through
// handleCoralMessage). Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the hold is a wall-clock timer in the page; what is asserted is what has (not) appeared by then
    const results = [];
    const scenario = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String((e && e.message) || e).split('\n')[0].slice(0, 300)); } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason)));` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('cx', 'C', 6, { sleeping: false, agent_type: 'codex' }); window.__m.add('cx2', 'D', 6, { sleeping: false, agent_type: 'codex' }); true`);
        const HOLD = await ev(`import(${MOD} + 'websocket.js').then(m => m.CODEX_REVIEW_HOLD_MS)`);
        const feed = (waiting, drop = []) => ev(`(async () => {
            const ws = await import(${MOD} + 'websocket.js'); const { state } = await import(${MOD} + 'state.js'); const w = ${JSON.stringify(waiting)}; const drop = ${JSON.stringify(drop)};
            const rows = Object.values(window.__m.agents).filter(a => !drop.includes(a.name)).map(a => ({ ...window.__m.entry(a), waiting_for_input: !!w[a.name], waiting_kind: w[a.name] ? w[a.name].kind : null, waiting_since: w[a.name] ? w[a.name].since : null }));
            state.settings = state.settings || {}; ws.handleCoralMessage({ type: 'coral_update', sessions: rows, servers: [] }); return true; })()`);
        const toasts = () => ev(`document.querySelectorAll('.notification-toast').length`);
        const clear = () => ev(`document.querySelectorAll('.notification-toast').forEach(t => t.remove()); true`);
        const reset = async () => { await clear(); await ev(`import(${MOD} + 'websocket.js').then(m => { m._resetWaitingSeedForTests(); return true; })`); await feed({}); await sleep(HOLD + 400); await clear(); }; // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
        await reset();

        await scenario('a Codex permission request that turns into a login prompt inside the hold alerts ONCE (the prompt at once; the held alert for the same row does not add a second)', async () => {
            await feed({ cx: { kind: 'permission', since: 'e1' } }); await sleep(800); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            await feed({ cx: { kind: 'login', since: 'e1' } });
            await waitFor(`document.querySelectorAll('.notification-toast').length >= 1`, 'the login prompt alerts', { timeout: 2500 });
            await sleep(HOLD + 800); const n = await toasts(); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            assert.ok(n <= 1, `${n} toasts for one row and one open prompt (a held alert for the old kind fired too)`);
        });
        await reset();
        await scenario('a row that goes away (its session ended) inside the hold alerts nobody and raises no error', async () => {
            await feed({ cx: { kind: 'permission', since: 'e2' } }); await sleep(600); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            await feed({}, ['cx']); await sleep(HOLD + 800); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            assert.equal(await toasts(), 0, 'no toast for a row that is gone'); assert.deepEqual(await ev(`window.__errs`), [], 'no error in the page');
            await ev(`window.__m.add('cx', 'C', 6, { sleeping: false, agent_type: 'codex' }); true`);
        });
        await reset();
        await scenario('the same open request fed again by every update alerts exactly once after the hold', async () => {
            await feed({ cx: { kind: 'permission', since: 'e3' } });
            for (let i = 0; i < 5; i++) { await sleep(HOLD / 4); await feed({ cx: { kind: 'permission', since: 'e3' } }); } // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            await sleep(600); assert.equal(await toasts(), 1, 'one toast, not one per update'); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
        });
        await reset();
        await scenario('after an alert, the request clears and a second one rises: it is alerted again after its own hold, not at once and not never', async () => {
            await feed({ cx: { kind: 'permission', since: 'e4a' } });
            await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'the first alert after the hold', { timeout: HOLD + 2500 }); await clear();
            await feed({}); await sleep(200); // sleep-ok: the hold is a wall-clock timer in the page; the assertion is what has (not) appeared by then
            await feed({ cx: { kind: 'permission', since: 'e4b' } }); assert.equal(await toasts(), 0, 'not at once');
            await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'the second alert after its own hold', { timeout: HOLD + 2500 });
        });
        const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`);
        if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
