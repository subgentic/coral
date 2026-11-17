// An agent compacting its conversation (#19090, Operator: a Claude agent ran /compact and Coral showed it as idle): the row says Compacting, not Idle or Working. The server sends row.compacting with working: true; when the compaction is over the
// row is an ordinary one again. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const row = (id, name, extra) => Object.assign({ session_id: id, name: 'coral-' + id, display_name: name, agent_type: 'claude', model: 'claude-opus-5-5', server: 'local', board_unread: 0, working: false, compacting: false, context_pct: null }, extra);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        const rows = [row('c1', 'Compacting One', { working: true, compacting: true }), row('c2', 'Busy Two', { working: true }), row('c3', 'Idle Three', {})];
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(rows)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 3`, 'the rows', 6000);
        const info = await ev(`import(${S} + 'session_state.js').then(m => Object.fromEntries(T.state.liveSessions.map(r => [r.display_name, m.sessionStateInfo(r).label])))`);
        check(info['Compacting One'] === 'Compacting', 'a compacting agent says Compacting: ' + JSON.stringify(info));
        check(info['Busy Two'] === 'Working' && info['Idle Three'] === 'Idle', 'the other agents keep their words: ' + JSON.stringify(info));
        const seen = await ev(`(() => { const r = document.querySelector('#live-sessions-list .session-group-item[data-session-id="c1"]'); return r ? r.textContent + ' ' + [...r.querySelectorAll('[aria-label],[title]')].map(e => (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')).join(' ') : ''; })()`);
        check(/Compacting/.test(seen) && !/\bIdle\b/.test(seen), 'the row itself says Compacting: ' + seen.slice(0, 200));
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS a compacting agent is shown as Compacting');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
