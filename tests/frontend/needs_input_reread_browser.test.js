// A card that has no choices because the terminal's options were not read says "Answer in the terminal" and now has a Check again (#15090, Beta walk 2 finding 4: one agent's card stayed so, with no Yes, while the
// others' had theirs). Check again reads the terminal once more through the chat route: when the options are there, the card shows them as its choices (the same Yes and No as every other agent's card); when they
// are not, the card stays and says so. The chat route is a page stub; the card is the real needs_input_card.js in the chat of a selected agent. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'QA Engineer', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    const TRUST = { title: 'Do you trust the files in this folder?', question: 'Do you trust the files in this folder?', unnumbered: true, ask_id: 'a1', options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }] };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const original = window.fetch; window.__reads = 0; window.__po = null;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/sessions/live/coral-go/chat') { window.__reads++; return Promise.resolve(new Response(JSON.stringify({ prompt_options: window.__po }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return original(url, opts); }; return true; })()`);
        await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
        await waitFor(`!!document.getElementById('live-history-messages')`, 'the chat', 10000);
        await ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state;
            const row = { ...${JSON.stringify(base)}, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Notification: Claude needs your permission to continue' }; st.liveSessions = [row];
            NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
            NI.syncNeedsInputCard(document.getElementById('live-history-messages'), row); return true; })()`);
        await waitFor(`!!document.querySelector('#live-history-messages .chat-needs-input .cni-hint')`, 'a card with no options', 6000);
        const card = () => ev(`(() => { const c = document.querySelector('#live-history-messages .chat-needs-input'); return c ? { hint: (c.querySelector('.cni-hint') || {}).textContent || '', again: !!c.querySelector('[data-more]'), answers: [...c.querySelectorAll('.cni-answer')].map(b => b.textContent.trim().replace(/^\\d+\\s*/, '')) } : null; })()`);
        let c = await card();
        check(c && c.hint === 'Answer in the terminal' && c.again && c.answers.length === 0, 'a card with no options says so and has Check again: ' + JSON.stringify(c));
        // nothing on the terminal screen yet: the card stays and says so
        await ev(`document.querySelector('[data-more]').click(); true`);
        await waitFor(`window.__reads >= 1`, 'the terminal was read again', 6000);
        await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the card is drawn again after the read
        c = await card();
        check(c && c.again && c.answers.length === 0, 'with nothing read the card stays with its Check again: ' + JSON.stringify(c));
        // the options are there now: they are the card's choices
        await ev(`window.__po = ${JSON.stringify(TRUST)}; document.querySelector('[data-more]').click(); true`);
        await waitFor(`document.querySelectorAll('#live-history-messages .chat-needs-input .cni-answer').length === 2`, 'the options become the choices', 6000).catch(() => {});
        c = await card();
        check(c && c.answers.some(a => /Yes, I trust this folder/.test(a)) && c.answers.some(a => /No, exit/.test(a)), 'Check again shows Yes and No, exit: ' + JSON.stringify(c));
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_input_reread_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
