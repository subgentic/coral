// #19153 (Security's SHOULD on #15975): the sidebar status mark's rules are a lazy sheet (sidebar_status.css); the first sleeping or failed row must not be drawn as a plain button while the sheet is on its way. The sheet's request is
// held: the mark is not shown (hidden, no unstyled flash); released, it is shown and styled (the moon glyph is the sheet's ::before). Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        let held = null, hold = true;
        await Fetch.enable({ patterns: [{ urlPattern: '*/css/sidebar_status.css*', requestStage: 'Request' }] });
        safePaused(client, e => { if (hold && !held) held = e.requestId; else Fetch.continueRequest({ requestId: e.requestId }); });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`(() => { const m = window.__m;
            for (const id of Object.keys(m.agents)) delete m.agents[id];
            m.add('ended-a', 'A', 3, { sleeping: true, sleep_reason: 'agent_exited', board_project: 'sleepy-team' });
            T.state.liveSessions = Object.values(m.agents).map(a => m.entry(a)); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`!!document.querySelector('.session-group-item .terminal-gone-chip')`, 'the marked row is drawn', 6000);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the held sheet does not arrive; the mark is what is checked meanwhile
        assert.ok(held, 'the sheet was asked for when the first mark was drawn');
        const before = await ev(`(() => { const c = document.querySelector('.session-group-item .terminal-gone-chip'); return { hidden: c.hidden, shown: c.getClientRects().length > 0 }; })()`);
        assert.deepEqual(before, { hidden: true, shown: false }, 'while the sheet is on its way the mark is not drawn as a plain button: ' + JSON.stringify(before));
        hold = false; await Fetch.continueRequest({ requestId: held });
        await waitFor(`(() => { const c = document.querySelector('.session-group-item .terminal-gone-chip'); return !!c && !c.hidden && c.getClientRects().length > 0 && getComputedStyle(c, '::before').content !== 'none' && getComputedStyle(c, '::before').content !== 'normal'; })()`, 'the mark is shown, styled, when the sheet lands', 6000);
        console.log('PASS the first sidebar status mark waits for its sheet instead of flashing as a plain button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
