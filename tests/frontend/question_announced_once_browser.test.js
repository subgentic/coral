// A question the agent asks is announced once (Beta #10372 finding 3, #10374): the card in the chat is a role=alert ("Question: Pick a color: 1 Red 2 Blue"), the notification toast was a polite status of the same question
// ("Orchestrator needs your answer: Wants to know: Pick a color"), and the key strip said a third time "Keys for the question are shown": a listener heard it three times. With the card on screen the toast and the strip say
// nothing of their own (the toast and its link are still there to see and use); with the question's card not on screen (another agent's, or the Terminal view) the toast still announces it, so a question is never silent. 1280 px, a stubbed
// agent. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); localStorage.removeItem('coral-agent-keys'); window.__m.add('coral-go', 'm', 3, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('live-history-messages') && !!document.getElementById('command-input')`, 'the chat', 10000);
        const ask = (sid, viewChat) => ev(`(async () => {
            const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state;
            const base = window.__m.entry(window.__m.agents[${JSON.stringify(sid)}]);
            const row = { ...base, waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Wants to know: Pick a color', needs_input: true };
            NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear();
            NI.promptOptionsBySession.set(${JSON.stringify(sid)}, { question: 'Pick a color:', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }] });
            document.querySelectorAll('#notices .toast, #notices .notification-toast').forEach(e => e.remove());
            for (const id of ['notice-live', 'agent-keys-status']) { const e = document.getElementById(id); if (e) e.textContent = ''; }
            st.liveSessions = [...st.liveSessions.filter(s => s.session_id !== ${JSON.stringify(sid)}), row];
            ${viewChat ? "NI.syncNeedsInputCard(document.getElementById('live-history-messages'), row);" : "document.querySelectorAll('#live-history-messages > .chat-needs-input').forEach(e => e.remove());"}
            window.T.ws.handleCoralMessage({ type: 'coral_diff', changed: [row] });
            (await import(${S} + 'agent_keys.js')).syncAgentKeys(row);
            return true; })()`);
        const said = () => ev(`(() => ({ card: [...document.querySelectorAll('#live-history-messages > .chat-needs-input')].filter(e => e.getClientRects().length > 0 && e.getAttribute('role') === 'alert').length, notice: ((document.getElementById('notice-live') || {}).textContent || '').trim(), keys: ((document.getElementById('agent-keys-status') || {}).textContent || '').trim(), toast: document.querySelectorAll('.notification-toast').length }))()`);
        // the card on screen: one announcement, the card's
        await ask('o1', true); await new Promise(r => setTimeout(r, 900)); // sleep-ok: the status regions are written a frame later
        let s = await said();
        check(s.card === 1, `the card is an alert on screen: ${JSON.stringify(s)}`);
        check(s.toast >= 1, `the toast is still there to see and use: ${JSON.stringify(s)}`);
        check(s.notice === '' && s.keys === '', `with the card on screen the toast and the keys strip say nothing of their own (the card is the one announcement): ${JSON.stringify(s)}`);
        // the card not on screen: the toast says it
        await ev(`window.__m.add('coral-go2', 'm', 3, { sleeping: false, session_id: 'o2' }); true`);
        await ask('o2', false); await new Promise(r => setTimeout(r, 900)); // sleep-ok: the status regions are written a frame later
        s = await said();
        check(/needs your answer|Pick a color/.test(s.notice), `another agent's question, whose card is not on screen: the toast announces it: ${JSON.stringify(s)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'a question announced once:\n  ' + problems.join('\n  '));
    console.log('PASS a question is announced once');
})().catch(e => { console.error(e); process.exit(1); });
