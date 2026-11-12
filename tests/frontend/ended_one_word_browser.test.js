// #15777 (the Operator, from a shot): an agent whose CLI exited showed a moon, a red "Ended" chip, a "Sleeping" pill and "Sleep" in one row: three words for one state. Now its row says Ended
// and no moon and no Sleeping pill. At a hover Restart, Wake and Sleep (the Operator's decision) take the chip's place (at the keyboard they show beside it, which keeps the focus); a touch screen keeps the chip, which restarts on a tap
// (the menu has the rest). The chip's tooltip says why. Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); true`);
        await ev(`(() => {
            const m = window.__m;
            for (const id of Object.keys(m.agents)) delete m.agents[id];
            m.add('ended-one', 'E', 3, { sleeping: true, sleep_reason: 'agent_exited', board_project: 'one-team' });
            m.add('nap-one', 'N', 3, { sleeping: true, board_project: 'one-team' });
            T.state.liveSessions = Object.values(m.agents).map(a => m.entry(a));
            T.render.renderLiveSessions(T.state.liveSessions);
            return true;
        })()`);
        await waitFor(`!!document.querySelector('.session-group-item[data-session-id="ended-one-id"]')`, 'the ended agent\'s row', 5000);
        const read = () => ev(`(() => { const li = document.querySelector('.session-group-item[data-session-id="ended-one-id"]'), row = li.querySelector('.session-name-row');
            const words = [...row.querySelectorAll('.terminal-gone-chip, .session-state-pill, .btn')].filter(e => e.textContent.trim()).map(e => ({ text: e.textContent.trim(), shown: e.getClientRects().length > 0, title: e.title || '' }));
            return { words, shownWords: words.filter(w => w.shown).map(w => w.text), dotShown: getComputedStyle(li.querySelector('.session-dot')).visibility !== 'hidden' }; })()`);
        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`T.render.renderLiveSessions(T.state.liveSessions); true`);
            await waitFor(`(() => { const c = document.querySelector('.session-group-item[data-session-id="ended-one-id"] .terminal-gone-chip'); return !!c && c.getClientRects().length > 0; })()`, 'the Ended chip laid out at ' + width, 5000);
            const r = await read();
            const all = r.words.map(w => w.text);
            assert.ok(!all.includes('Sleeping'), `${width}: no Sleeping pill on an ended row: ${JSON.stringify(all)}`);
            assert.deepEqual(r.shownWords, ['Ended'], `${width}: at rest the row says one word, Ended: ${JSON.stringify(r.words)}`);
            assert.equal(r.words.find(w => w.text === 'Ended').title, 'Its program exited; Restart starts it again', `${width}: the tooltip says why`);
            assert.equal(r.dotShown, false, `${width}: no moon (the state dot is hidden)`);
            assert.deepEqual(all.filter(w => w !== 'Ended').sort(), ['Restart', 'Sleep', 'Wake'], `${width}: the three actions are on the row: ${JSON.stringify(all)}`);
        }
        console.log('   ✓ an ended row says Ended alone, with Restart as its one action');

        // At the keyboard the three actions show beside the chip.
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await ev(`T.render.renderLiveSessions(T.state.liveSessions); true`);
        await ev(`document.querySelector('.session-group-item[data-session-id="ended-one-id"] .terminal-gone-chip').focus(); true`); // the keyboard reaches the row through its chip
        await waitFor(`(() => { const li = document.querySelector('.session-group-item[data-session-id="ended-one-id"]'); const shown = [...li.querySelectorAll('.session-name-row > .btn, .terminal-gone-chip')].filter(e => e.getClientRects().length > 0).map(e => e.textContent.trim()).sort().join('|'); return shown === 'Ended|Restart|Sleep|Wake'; })()`, 'Restart, Wake and Sleep beside the focused chip, which stays', 4000, `[...document.querySelectorAll('.session-group-item[data-session-id="ended-one-id"] .session-name-row > *')].map(e => e.textContent.trim() + ':' + (e.getClientRects().length > 0)).join('|')`);
        console.log('   ✓ on focus Restart, Wake and Sleep show beside the chip, which keeps the focus');
        console.log('\nAll ended-one-word checks passed');
    } finally {
        await client.close();
    }
})().catch(err => { console.error(err); process.exit(1); });
