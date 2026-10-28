// The keyboard stays on the page when the agent's question or permission card changes (#10247, the first run walked by keyboard): Tab to Red or Yes, and (1) when the card is drawn again with new words (the agent's
// screen changed) the keyboard is on the same answer, not on the body; (2) when the card is answered and goes away the keyboard is on the message box, where the person types next, not on the body. At 1280 and 640 px
// (200% zoom). Drives Chrome over CDP through agent_view_harness.js; the card is the real needs_input_card.js, built in the chat of a selected agent.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const S = `(window.__coralStatic || '/static/')`;
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.dataset && a.dataset.n ? '[n=' + a.dataset.n + ']' : '') + ' ' + (a.className || '').toString().slice(0, 30); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [640, 400]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0 && !!document.getElementById('live-history-messages')`, `${w}: the chat with its message box`, 10000);
            for (const [what, summary, options] of [['question', 'Wants to know: Pick a color', [['Red', 'select'], ['Blue', 'select']]], ['permission', 'Wants to run: rm -rf /tmp/x', [['Yes', 'select'], ['No', 'select']]]]) {
                const check = (ok, msg) => { if (!ok) problems.push(`${w}, ${what}: ${msg}`); };
                const draw = (sum, open) => ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state;
                    const row = { ...${JSON.stringify(base)}, waiting_for_input: ${open}, waiting_summary: ${JSON.stringify(sum)} }; st.liveSessions = [row];
                    NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
                    if (${open}) NI.promptOptionsBySession.set('o1', { question: ${JSON.stringify(what === 'question' ? 'Pick a color:' : 'Do you want to proceed?')}, options: ${JSON.stringify(options.map(([label, action], i) => ({ n: i + 1, label, action, selected: i === 0 })))} });
                    NI.syncNeedsInputCard(document.getElementById('live-history-messages'), row); return true; })()`);
                await draw(summary, true);
                await waitFor(`document.querySelectorAll('#live-history-messages .chat-needs-input .cni-answer').length === 2`, `${w}: the ${what} card`, 5000);
                // (1) the keyboard is on the second answer; the card is drawn again with new words: still on that answer
                await ev(`document.querySelector('#live-history-messages .cni-answer[data-n="2"]').focus(); true`);
                check(/cni-answer/.test(await where()), 'the second answer takes the keyboard: ' + await where());
                await draw(summary + ' (the screen changed)', true);
                const after = await where();
                check(/cni-answer/.test(after) && /n=2/.test(after), `the card drawn again with new words keeps the keyboard on the same answer (it is on ${after})`);
                // (2) the card is answered and goes away: the keyboard is on the message box
                await ev(`document.querySelector('#live-history-messages .cni-answer[data-n="1"]').focus(); true`);
                await draw('', false);
                check(await ev(`!document.querySelector('#live-history-messages .chat-needs-input')`), 'the answered card is gone');
                const gone = await where();
                check(/command-input/.test(gone), `with the card answered the keyboard is in the message box (it is on ${gone})`);
                // a card taken away while the keyboard is elsewhere does not pull it
                await draw(summary, true);
                await waitFor(`document.querySelectorAll('#live-history-messages .chat-needs-input .cni-answer').length === 2`, `${w}: the ${what} card again`, 5000);
                await ev(`document.querySelector('#chat-find-btn') ? document.querySelector('#chat-find-btn').focus() : document.querySelector('#live-view-btn-chat').focus(); true`);
                const elsewhere = await where();
                await draw('', false);
                check(await where() === elsewhere, `a card that goes away while the keyboard is elsewhere leaves it there (${elsewhere} became ${await where()})`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the keyboard and the question card:\n  ' + problems.join('\n  '));
    console.log('PASS the keyboard stays on the page when the question card changes or is answered');
})().catch(e => { console.error(e); process.exit(1); });
