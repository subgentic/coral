// A model change from the chip reaches the Agents row (#17427, walk 63 F5): the feed says the agent now runs Sonnet and the row's model line, the chip and the chat's header
// all say Sonnet at once, not "Haiku 5.5 · Default · Medium" minutes later. Drives the feed with a diff that carries only the model, as the server's does after a switch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, h, mobile, list] of [['1280', 1280, 800, false, '#live-sessions-list'], ['390', 390, 844, true, '#mobile-session-list']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); localStorage.setItem('coral-show-model', 'true'); true`);
            await ev(`(() => { window.__row = { session_id: 'l1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', model: 'claude-haiku-5-5', thinking_actual: 'medium', working_directory: '/work/coral', repo_name: 'coral' }; T.state.liveSessions = [window.__row]; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            const rowText = () => ev(`(() => { const m = document.querySelector('${list} .session-group-item .session-model'); return m ? m.textContent : null; })()`);
            await waitFor(`!!document.querySelector('${list} .session-group-item .session-model')`, `${tag}: the row's model line`, 6000);
            assert.equal(await rowText(), 'Haiku 5.5 · Default · Medium', `${tag}: the row starts on Haiku`);
            await ev(`(() => { T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...window.__row, model: 'claude-sonnet-5-5' }] }); if (${mobile}) import((window.__coralStatic || '/static/') + 'mobile.js').then(m => m.syncMobileAgentList()); return true; })()`);
            await waitFor(`(document.querySelector('${list} .session-group-item .session-model')||{}).textContent === 'Sonnet 5.5 · Default · Medium'`, `${tag}: the row says Sonnet 5.5 after the feed's model change (it said ${JSON.stringify(await rowText())})`, 4000);
            console.log(`${tag}: the row follows a model-only change`);
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
