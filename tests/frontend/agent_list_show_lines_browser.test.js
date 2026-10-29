// The agent list's Display options have Show summary and Show model (#10816, the operator: they were gone; #9686's one-line row removed their five switches, ce1946c0c). Both off by default, so a row
// is one line; each adds one quiet line when on; the choice survives a reload. Drives Chrome over CDP through agent_view_harness.js, at 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ROW = { session_id: 'l1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', working_directory: '/work/coral', repo_name: 'coral' };
    const rows = () => ev(`(async () => { T.state.liveSessions = ${JSON.stringify([ROW])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
    const lines = () => ev(`(() => { const li = document.querySelector('#live-sessions-list .session-group-item'); return { summary: li.querySelector('.session-line2')?.textContent || '', model: li.querySelector('.session-model')?.textContent || '', h: Math.round(li.getBoundingClientRect().height) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`try { localStorage.removeItem('coral-show-summary'); localStorage.removeItem('coral-show-model'); } catch (e) {} true`);
        await rows(); await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item')`, 'the row', 6000);
        console.log('1. both choices are in Display options, off, and the row is one line');
        const boxes = await ev(`['display-show-summary', 'display-show-model'].map(id => { const b = document.getElementById(id); return b ? { checked: b.checked, label: b.closest('label').textContent.trim() } : null; })`);
        assert.deepEqual(boxes, [{ checked: false, label: 'Show summary' }, { checked: false, label: 'Show model' }], JSON.stringify(boxes));
        let l = await lines(); assert.ok(!l.summary && !l.model && l.h <= 38, 'one line by default ' + JSON.stringify(l));
        console.log('2. each switch shows its line on the row');
        await ev(`document.getElementById('display-show-summary').click(); true`);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-line2')`, 'the summary line', 6000);
        l = await lines(); assert.equal(l.summary, 'Ship the release plan'); assert.equal(l.model, '');
        await ev(`document.getElementById('display-show-model').click(); true`);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-model')`, 'the model line', 6000);
        l = await lines(); assert.match(l.model, /Opus/); assert.ok(l.h > 38, 'the row grew by the lines ' + JSON.stringify(l));
        console.log('3. the choices survive a reload');
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await rows(); await waitFor(`!!document.querySelector('#live-sessions-list .session-model')`, 'the lines after a reload', 6000);
        assert.deepEqual(await ev(`['display-show-summary', 'display-show-model'].map(id => document.getElementById(id).checked)`), [true, true]);
        console.log('4. off again, the row is one line');
        await ev(`document.getElementById('display-show-summary').click(); document.getElementById('display-show-model').click(); true`);
        await waitFor(`!document.querySelector('#live-sessions-list .session-line2') && !document.querySelector('#live-sessions-list .session-model')`, 'the lines gone', 6000);
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
