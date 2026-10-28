// #7974: presentation evidence quiets every attention surface without resolving
// the permission or sending input. The server's prompt/settle/read guards have
// real-exec and explicitly composed fixtures in Go; these are payload fixtures.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => {
                const base = window.__coralStatic || '/static/';
                window.H = await import(base + 'session_state.js'); window.I = await import(base + 'inbox_tab.js');
                window.C = await import(base + 'needs_input_card.js'); window.U = await import(base + 'session_header_updates.js');
                window.a = __m.add('hint-codex', 'H', 1, { sleeping: false, agent_type: 'codex' });
                window.card = document.createElement('div'); document.body.appendChild(card);
                T.ws._resetWaitingSeedForTests();
                T.ws.handleCoralMessage({ type: 'coral_update', sessions: [__m.entry(a)], servers: [] });
                window.feed = (extra = {}, age = 0) => {
                    const now = Date.now();
                    const row = { ...__m.entry(a), working: false, not_started: false, needs_login: false, stuck: false, waiting_for_input: true, waiting_kind: 'permission',
                        waiting_since: new Date(now - 60000).toISOString(), display_activity_hint: 'working',
                        display_activity_hint_at: new Date(now - age).toISOString(), held_messages: [{ id: 'held-1', text: 'stay held', held_at: 'fixture' }], ...extra };
                    T.ws.handleCoralMessage({ type: 'coral_update', sessions: [row], servers: [] });
                    U.updateWaitingIndicator(row); C.syncNeedsInputCard(card, row);
                    return true;
                };
                window.snapshot = () => {
                    const row = T.state.liveSessions.find(s => s.session_id === a.session_id);
                    const root = document.querySelector(${JSON.stringify(width === 390 ? '#mobile-session-list' : '#live-sessions-list')});
                    const item = root?.querySelector('[data-session-id="hint-codex-id"]');
                    return { authoritative: H.deriveSessionState(row), display: H.presentationSessionState(row), count: I.waitingCount(),
                        attention: item?.classList.contains('needs-attention'), pill: item?.querySelector('.session-state-pill')?.textContent || '',
                        mobileBanner: !!item?.querySelector('.session-mobile-banner'), header: document.getElementById('waiting-banner')?.hidden,
                        card: !!card.querySelector('.chat-needs-input'), held: row.held_messages, toasts: document.querySelectorAll('.notification-toast').length };
                };
                feed(); return true;
            })()`);
            await waitFor(`!!document.querySelector('[data-session-id="hint-codex-id"]')`, 'hint row rendered', 10000, 'snapshot()');
            const quiet = await ev('snapshot()');
            assert.equal(quiet.authoritative, 'needs_input'); assert.equal(quiet.display, 'working');
            assert.equal(quiet.count, 0); assert.equal(quiet.attention, false); assert.equal(quiet.card, false);
            assert.equal(quiet.mobileBanner, false); assert.ok(!quiet.pill.includes('Needs input')); assert.equal(quiet.header, true); assert.equal(quiet.toasts, 0);
            assert.equal(quiet.held[0].id, 'held-1');
            for (const extra of [{ waiting_kind: 'question' }, { display_activity_hint: null }, { not_started: true }, { needs_login: true }]) {
                await ev(`feed(${JSON.stringify(extra)}); true`);
                const loud = await ev('snapshot()');
                assert.equal(loud.count, 1, `attention retained for ${JSON.stringify(extra)}`);
                assert.notEqual(loud.display, 'working');
            }
            // A current screen prompt card always wins over a footer hint.
            assert.equal(await ev(`C.promptOptionsBySession.set(a.session_id, { question: 'Approve?', options: [{ n: 1, label: 'Yes', action: '1' }] }); feed(); !!card.querySelector('.chat-needs-input')`), true);
            await ev(`C.promptOptionsBySession.delete(a.session_id); document.querySelectorAll('.notification-toast').forEach(e => e.remove()); feed({}, 9000); true`);
            // No feed arrives: the product lease timer must repaint row/count itself.
            await waitFor(`I.waitingCount() === 1 && document.querySelector('[data-session-id="hint-codex-id"].needs-attention')`, 'socket stall restores attention', 10000, 'snapshot()'); // a number of ms, with the row's state printed when it fails: the options object that was here made the wait endless (a hung suite the runner killed at 120 s)
            assert.equal(await ev(`T.state.liveSessions[0].waiting_for_input && T.state.liveSessions[0].held_messages[0].id === 'held-1'`), true);
            assert.equal(await ev(`__m.requests.filter(r => ['send', 'keys', 'held'].includes(r.kind)).length`), 0, 'presentation sent no input');
            console.log(`PASS #7974 ${width}px: authoritative wait held, UI quiet, ambiguous states and stale lease restore attention`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
