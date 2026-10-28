// A sidebar agent row's hover tip on the keyboard (#9831, QA Reviewer 2 on #9822): the tip showed on mouseenter only, so a sighted keyboard user could not read a cut name. It now shows when real Tab presses put focus on the row, names the whole agent,
// stays while the focus is in the row, goes on Escape (focus does not move), and goes when Tab leaves the row for the next one (whose own tip shows). The row's accessible name is the one Chrome computes and does not change. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const KEYS = { Tab: [9, 'Tab'], Escape: [27, 'Escape'] };
    const key = async k => { const [code, name] = KEYS[k]; await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code }); await new Promise(r => setTimeout(r, 120)); }; // sleep-ok: the key's handlers run
    const LONG = 'Agent whose name the sidebar row has to cut'; // under the tip's own 60 characters
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 's', model: 'claude-opus-5-5', branch: 'b', repo_name: 'coral', working_directory: '/work/c', status: 'idle', server: 'local' }, o);
    const tips = () => ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].map(li => { const t = li.querySelector('.session-tooltip'); return { id: li.dataset.sessionId, shown: !!t && getComputedStyle(t).display === 'block', text: t ? t.textContent : '' }; })`);
    const active = () => ev(`(() => { const e = document.activeElement, li = e && e.closest && e.closest('.session-group-item'); return { id: li ? li.dataset.sessionId : '', row: !!li && e === li, tag: e ? e.tagName : '' }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([base({ session_id: 'k1', display_name: LONG }), base({ session_id: 'k2', display_name: 'Second' })])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 2`, 'the rows', 6000);
        await ev(`(document.querySelector('.sidebar input') || document.body).focus(); true`);
        let row = null;
        for (let i = 0; i < 12; i++) { await key('Tab'); const a = await active(); if (a.id === 'k1') { row = a; break; } }
        check(!!row, 'Tab reaches the first agent row');
        if (row) {
            await ev(`document.activeElement.closest('.session-group-item').setAttribute('data-axp', 'x'); true`);
            const before = await axName(client, '[data-axp="x"]');
            let t = await tips(); check(t.find(x => x.id === 'k1').shown, 'Tab onto the row shows its tip: ' + JSON.stringify(t));
            check(t.find(x => x.id === 'k1').text.includes('the sidebar row has to cut'), 'the tip names the whole agent: ' + JSON.stringify(t.find(x => x.id === 'k1').text.slice(0, 120)));
            const fAt = await active();
            await key('Escape'); t = await tips(); const fAfter = await active();
            check(!t.find(x => x.id === 'k1').shown, 'Escape hides the tip: ' + JSON.stringify(t));
            check(fAfter.id === fAt.id && fAfter.tag === fAt.tag, 'and focus has not moved: ' + JSON.stringify([fAt, fAfter]));
            const after = await axName(client, '[data-axp="x"]'); check(JSON.stringify(before) === JSON.stringify(after), 'the row\'s accessible name is unchanged: ' + JSON.stringify([before, after]));
            // Tab on: leaving k1 hides its tip, and k2's row shows its own
            let next = null; for (let i = 0; i < 12; i++) { await key('Tab'); const a = await active(); if (a.id === 'k2') { next = a; break; } }
            check(!!next, 'Tab reaches the second row');
            t = await tips(); check(!t.find(x => x.id === 'k1').shown && t.find(x => x.id === 'k2').shown, 'leaving the first row hides its tip and the second row\'s shows: ' + JSON.stringify(t.map(x => [x.id, x.shown])));
            for (let i = 0; i < 12 && (await active()).id === 'k2'; i++) await key('Tab');
            t = await tips(); check(!t.some(x => x.shown), 'Tab out of the list leaves no tip showing: ' + JSON.stringify(t.map(x => [x.id, x.shown])));
        }
    } finally { await client.close(); }
    assert.deepEqual(found, [], 'the sidebar row tip by keyboard:\n  ' + found.join('\n  '));
    console.log('PASS the sidebar row tip shows on keyboard focus');
})().catch(e => { console.error(e); process.exit(1); });
