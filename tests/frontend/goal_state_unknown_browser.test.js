// A goal state the server made up ('constructor', '__proto__', 'toString') is an unknown state, drawn as idle: the Goals State cell must not throw (Security's SHOULD on #15827, #15946).
// MARK was a plain object, so MARK['constructor'] was Object's own function and statusMark broke the cell. Drives Chrome through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        const r = await ev(`(async () => {
            const m = await import((window.__coralStatic || '/static/') + 'goal_columns.js');
            const col = m.goalColumns({}, ['state'])[0], out = Object.create(null);
            for (const state of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'bogus', 'active', 'Done']) {
                try { const n = col.cell({ id: 1, title: 'g', state, rollup: {} }); out[state] = n instanceof Node ? (n.getAttribute('data-state') || n.className || n.outerHTML.slice(0, 80)) : String(n); } catch (e) { out[state] = 'THROWS ' + e.message; }
            }
            return out; })()`);
        for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'bogus']) assert.ok(!/^THROWS/.test(r[k]), `${k} does not throw: ${JSON.stringify(r)}`);
        for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(r[k], r.bogus, `${k} reads like any unknown state (idle): ${JSON.stringify(r)}`);
        assert.notEqual(r.active, r.bogus, 'a known state still has its own mark: ' + JSON.stringify(r));
        assert.equal(r.Done !== r.bogus, true, 'a known state is matched in any case: ' + JSON.stringify(r));
        console.log('PASS an unknown goal state, even one named like an Object property, draws as idle and never throws');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
