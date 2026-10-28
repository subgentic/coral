// A toast never covers the chat's answer card (Beta #10221, #10251): when a question arrives, its "needs your answer" toast stacks bottom right, and at 1280 it sat over the right side of the question card.
// The toast column is narrow enough (380 px) to stay in the file column's room when that is open, at 1280 and 1024 px. A stubbed agent, as in question_announced_once. Shots in CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, height, dock] of [[1280, 800, 'false'], [1024, 768, 'false'], [1280, 800, 'true'], [1024, 768, 'true']]) { // the file column open (dock false = not collapsed) and shut
        await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-agentic-collapsed', '${dock}'); true`); // the column open, where the toast belongs, and shut, where the card spans the chat
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
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
        await ask('o1', true); await new Promise(r => setTimeout(r, 900)); // sleep-ok: the toast slides in
        const g = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; }; const card = document.querySelector('#live-history-messages > .chat-needs-input'), toasts = [...document.querySelectorAll('.notification-toast')].filter(e => e.getClientRects().length); return { card: card ? r(card) : null, toasts: toasts.map(r) }; })()`);
        check(g.card && g.toasts.length >= 1, `${width} dock ${dock === 'true' ? 'shut' : 'open'}: the card and a toast are on screen: ${JSON.stringify(g)}`);
        const over = (g.toasts || []).filter(t => g.card && t.l < g.card.r && t.r > g.card.l && t.t < g.card.b && t.b > g.card.t);
        check(over.length === 0, `${width} dock ${dock === 'true' ? 'shut' : 'open'}: no toast covers the question card: ${JSON.stringify(g)}`);
        const shotDir = process.env.CORAL_SCREENSHOT_DIR; if (shotDir) { require('node:fs').mkdirSync(shotDir, { recursive: true }); require('node:fs').writeFileSync(`${shotDir}/question-toast-${width}-${dock === 'true' ? 'shut' : 'open'}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'a toast never covers the answer card:\n  ' + problems.join('\n  '));
    console.log('PASS a toast never covers the answer card');
})().catch(e => { console.error(e); process.exit(1); });
