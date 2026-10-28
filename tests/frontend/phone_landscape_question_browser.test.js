// A question's choices stay visible in landscape (Mobile pass 30, #10385, #10388): the card (kicker, question, a button a row and Open terminal) was taller than the chat's 176 px and the composer hid its choices. At 844 x 390
// the card is compact: its answers are one row of buttons (44 px tall), the whole card is no taller than 145 px, and every answer is inside the chat's area when the chat is scrolled to the end. A stubbed agent.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width), bottom: Math.round(r.bottom) }; })()`);
    const open = async (h = 390) => {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 844, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__m.add('coral-go', 'm', 8, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the chat', 10000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the page settles
    };
    try {
        await open();
        // drawn and measured in one go: the page's own refresh of a stubbed agent clears the options a moment later
        const m = await ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const base = window.__m.entry(window.__m.agents['o1']);
            const row = { ...base, waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Wants to know: Pick a color', needs_input: true };
            NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
            NI.promptOptionsBySession.set('o1', { question: 'Pick a color:', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }] });
            st.liveSessions = [row]; const box = document.getElementById('live-history-messages'); NI.syncNeedsInputCard(box, row); box.scrollTop = box.scrollHeight;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // raf-ok: the card is drawn and measured in one call, before the page's own refresh clears the stubbed options; the runner's page is visible here
            const r = e => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), h: Math.round(b.height) }; };
            const card = box.querySelector('.chat-needs-input');
            return { msgs: r(box), card: card ? r(card) : null, answers: [...box.querySelectorAll('.cni-answer')].map(r) }; })()`);
        check(m.card && m.card.h <= 145, `the card is compact (145 px at most): ${JSON.stringify(m)}`);
        check(m.answers.length === 2 && m.answers.every(a => a.top >= m.msgs.top - 1 && a.bottom <= m.msgs.bottom + 1 && a.h >= 44), `both answers are inside the chat's area and 44 px tall: ${JSON.stringify(m)}`);
        check(m.answers.length === 2 && Math.abs(m.answers[0].top - m.answers[1].top) <= 2, `and they sit in one row: ${JSON.stringify(m.answers)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'question:\n  ' + problems.join('\n  '));
    console.log('PASS question');
})().catch(e => { console.error(e); process.exit(1); });
