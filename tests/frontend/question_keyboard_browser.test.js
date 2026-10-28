// Answering a question by keyboard (Beta #10401 moment 5, #10410): (1) a new question's card takes the keyboard on its first answer, where it went to the hidden terminal box and the answers were 53 Tab stops away, unless the
// person has typed something in the message box (their words are not taken); (2) Enter on an answer button answers (as Space does); (3) the number keys 1 and 2, which the card's own labels show, pick that answer when the keyboard is
// in the card. The answer goes to the agent's answer-prompt route (stubbed, recorded). 1280 px, a stubbed agent. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const press = async (key, code, vk, text) => { await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('coral-go', 'm', 3, { sleeping: false, session_id: 'o1' }); window.__posts = []; { const R = window.fetch; window.fetch = (u, o = {}) => { if (/answer-prompt/.test(String(u))) { window.__posts.push(JSON.parse(o.body || '{}')); return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; } true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the chat', 10000);
        const draw = (draft) => ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const base = window.__m.entry(window.__m.agents['o1']);
            const row = { ...base, waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Wants to know: Pick a color', needs_input: true };
            document.querySelectorAll('#live-history-messages > .chat-needs-input').forEach(e => e.remove()); window.__posts.length = 0;
            const box = document.getElementById('command-input'); box.value = ${JSON.stringify(draft)}; box.focus();
            NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
            NI.promptOptionsBySession.set('o1', { question: 'Pick a color:', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }] });
            st.liveSessions = [row]; NI.syncNeedsInputCard(document.getElementById('live-history-messages'), row);
            await new Promise(r => setTimeout(r, 150)); // sleep-ok: the card takes the keyboard on the next frame
            const a = document.activeElement; return { cls: a ? String(a.className) : '', n: a && a.dataset ? a.dataset.n : '', id: a ? a.id : '' }; })()`);
        // (1) a new question takes the keyboard on its first answer; typed words are not taken
        let f = await draw('');
        check(/cni-answer/.test(f.cls) && f.n === '1', `a new question's card takes the keyboard on its first answer: ${JSON.stringify(f)}`);
        // (2) Enter answers
        await press('Enter', 'Enter', 13, '\r'); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the answer is sent
        const enter = await ev(`window.__posts.slice()`);
        check(enter.length === 1 && enter[0].n === 1, `Enter on the first answer answers it: ${JSON.stringify(enter)}`);
        // (3) the number keys pick the answer
        f = await draw('');
        await press('2', 'Digit2', 50, '2'); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the answer is sent
        const two = await ev(`window.__posts.slice()`);
        check(two.length === 1 && two[0].n === 2, `the key 2 picks the second answer: ${JSON.stringify(two)}`);
        // typed words keep the keyboard
        f = await draw('my half-typed message');
        check(f.id === 'command-input', `a message half typed keeps the keyboard when a question appears: ${JSON.stringify(f)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'answering a question by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS a question takes the keyboard, Enter and the number keys answer it');
})().catch(e => { console.error(e); process.exit(1); });
