// The agent list's Display options have Show summary and Show model (#10816, the operator: they were gone; #9686's one-line row removed their five switches, ce1946c0c). Both off by default, so a row
// is one line; each adds one quiet line when on; the choice survives a reload. At 1280 px (the sidebar's panel) and 390 px (the phone's). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ROW = { session_id: 'l1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', working_directory: '/work/coral', repo_name: 'coral' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, h, mobile, list, header] of [['1280', 1280, 800, false, '#live-sessions-list', '.sidebar-header'], ['390', 390, 844, true, '#mobile-session-list', '.mobile-list-header']]) {
            const rows = async () => { await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([ROW])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`); if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`); await waitFor(`!!document.querySelector('${list} .session-group-item')`, `${tag}: the row`, 6000); };
            const B = `(k => document.querySelector('${header} [data-display-input="' + k + '"]'))`; // page side
            const lines = () => ev(`(() => { const li = document.querySelector('${list} .session-group-item'); return { summary: li.querySelector('.session-line2')?.textContent || '', model: li.querySelector('.session-model')?.textContent || '', h: Math.round(li.getBoundingClientRect().height) }; })()`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`try { localStorage.removeItem('coral-show-summary'); localStorage.removeItem('coral-show-model'); } catch (e) {} true`);
            await rows();
            console.log(`${tag}: both choices are in Display options, off, and the row is one line`);
            const boxes = await ev(`['summary', 'model'].map(k => { const b = ${B}(k); return b ? { checked: b.checked, label: b.closest('label').textContent.trim() } : null; })`);
            assert.deepEqual(boxes, [{ checked: false, label: 'Show summary' }, { checked: false, label: 'Show model' }], `${tag}: ` + JSON.stringify(boxes));
            let l = await lines(); assert.ok(!l.summary && !l.model, `${tag}: one line by default ` + JSON.stringify(l));
            const oneLine = l.h;
            console.log(`${tag}: each switch shows its line on the row`);
            await ev(`${B}('summary').click(); true`);
            await waitFor(`!!document.querySelector('${list} .session-line2')`, `${tag}: the summary line`, 6000);
            l = await lines(); assert.equal(l.summary, 'Ship the release plan'); assert.equal(l.model, '');
            await ev(`${B}('model').click(); true`);
            await waitFor(`!!document.querySelector('${list} .session-model')`, `${tag}: the model line`, 6000);
            l = await lines(); assert.match(l.model, /Opus/); assert.ok(l.h > oneLine, `${tag}: the row grew by the lines ` + JSON.stringify([oneLine, l]));
            console.log(`${tag}: the choices survive a reload`);
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await rows(); await waitFor(`!!document.querySelector('${list} .session-model')`, `${tag}: the lines after a reload`, 6000);
            assert.deepEqual(await ev(`['summary', 'model'].map(k => ${B}(k).checked)`), [true, true]);
            console.log(`${tag}: off again, the row is one line`);
            await ev(`${B}('summary').click(); ${B}('model').click(); true`);
            await waitFor(`!document.querySelector('${list} .session-line2') && !document.querySelector('${list} .session-model')`, `${tag}: the lines gone`, 6000);
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
